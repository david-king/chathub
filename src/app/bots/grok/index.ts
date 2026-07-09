import { v4 as uuidv4 } from 'uuid'
import { ChatError, ErrorCode } from '~utils/errors'
import { parseSSEResponse } from '~utils/sse'
import { AbstractBot, SendMessageParams } from '../abstract-bot'
import { grokWebClient } from './client'

const FALLBACK_STATSIG_ID =
  'ZTpUeXBlRXJyb3I6IENhbm5vdCByZWFkIHByb3BlcnRpZXMgb2YgdW5kZWZpbmVkIChyZWFkaW5nICdjaGlsZE5vZGVzJyk='

interface ConversationContext {
  conversationId: string
  lastResponseId?: string
}

interface GrokStreamPayload {
  result?: {
    conversation?: {
      conversationId?: string
    }
    response?: GrokStreamResponse
    responseId?: string
    token?: string
    messageTag?: string
    isThinking?: boolean
    isSoftStop?: boolean
    finalMetadata?: unknown
    modelResponse?: {
      message?: string
    }
  }
}

interface GrokStreamResponse {
  responseId?: string
  token?: string
  messageTag?: string
  isThinking?: boolean
  isSoftStop?: boolean
  finalMetadata?: unknown
  modelResponse?: {
    message?: string
  }
}

function buildCommonPayload() {
  return {
    fileAttachments: [],
    imageAttachments: [],
    disableSearch: false,
    enableImageGeneration: true,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: true,
    imageGenerationCount: 2,
    forceConcise: false,
    enableSideBySide: true,
    sendFinalMetadata: true,
    disableTextFollowUps: false,
    disableMemory: false,
    forceSideBySide: false,
    isAsyncChat: false,
    disableSelfHarmShortCircuit: false,
    collectionIds: [],
    disabledConnectorIds: [],
    deviceEnvInfo: {
      darkModeEnabled: false,
      devicePixelRatio: window.devicePixelRatio || 1,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    },
    linkQuery: false,
  }
}

export class GrokWebBot extends AbstractBot {
  private conversationContext?: ConversationContext

  async doSendMessage(params: SendMessageParams) {
    const path = this.conversationContext
      ? `/rest/app-chat/conversations/${this.conversationContext.conversationId}/responses`
      : '/rest/app-chat/conversations/new'

    const payload = this.conversationContext
      ? {
          message: params.prompt,
          parentResponseId: this.conversationContext.lastResponseId,
          ...buildCommonPayload(),
          metadata: {},
          modeId: 'fast',
        }
      : {
          temporary: false,
          message: params.prompt,
          ...buildCommonPayload(),
          responseMetadata: {},
          modeId: 'fast',
        }

    const resp = await grokWebClient.fetch(path, {
      method: 'POST',
      signal: params.signal,
      credentials: 'include',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'x-statsig-id': FALLBACK_STATSIG_ID,
        'x-xai-request-id': uuidv4(),
      },
      body: JSON.stringify(payload),
    })

    if (resp.status === 401 || resp.status === 403) {
      throw new ChatError(
        'Please sign in to grok.com in this browser and finish browser verification.',
        ErrorCode.GROK_UNAVAILABLE,
      )
    }
    if (resp.status === 429) {
      throw new ChatError('Grok rate limit exceeded. Please try again later.', ErrorCode.GROK_UNAVAILABLE)
    }

    let result = ''
    let done = false
    let fallbackMessage = ''

    await parseSSEResponse(resp, (message) => {
      if (message === '[DONE]') {
        done = true
        return
      }

      let payload: GrokStreamPayload
      try {
        payload = JSON.parse(message)
      } catch (err) {
        console.debug('Ignoring unknown Grok stream frame', message, err)
        return
      }

      const streamResult = payload.result
      if (!streamResult) {
        return
      }

      const conversationId = streamResult.conversation?.conversationId
      if (conversationId) {
        this.conversationContext = {
          conversationId,
          lastResponseId: this.conversationContext?.lastResponseId,
        }
      }

      const response = streamResult.response || streamResult
      if (response.responseId && this.conversationContext) {
        this.conversationContext.lastResponseId = response.responseId
      }

      if (response.modelResponse?.message) {
        fallbackMessage = response.modelResponse.message
      }

      if (response.messageTag === 'final' && response.isThinking !== true && response.token !== undefined) {
        result += response.token
        params.onEvent({ type: 'UPDATE_ANSWER', data: { text: result } })
      }

      if (response.isSoftStop || response.finalMetadata) {
        done = true
      }
    })

    if (!result && fallbackMessage) {
      result = fallbackMessage
      params.onEvent({ type: 'UPDATE_ANSWER', data: { text: result } })
    }

    if (!this.conversationContext) {
      throw new Error('Grok stream did not return a conversation id')
    }

    if (!done) {
      console.debug('Grok stream ended without an explicit terminal event')
    }
    params.onEvent({ type: 'DONE' })
  }

  resetConversation() {
    this.conversationContext = undefined
  }

  get name() {
    return 'Grok (webapp)'
  }
}
