import Browser from 'webextension-polyfill'
import {
  ProxyFetchRequestMessage,
  ProxyFetchResponseBodyChunkMessage,
  ProxyFetchResponseMetadataMessage,
  RequestInitSubset,
} from '~types/messaging'
import { uuid } from '~utils'
import { string2Uint8Array, uint8Array2String } from '~utils/encoding'
import { streamAsyncIterable } from '~utils/stream-async-iterable'

export function setupProxyExecutor() {
  Browser.runtime.onConnect.addListener((port) => {
    const abortController = new AbortController()
    port.onDisconnect.addListener(() => abortController.abort())
    port.onMessage.addListener(async (message: ProxyFetchRequestMessage) => {
      console.debug('proxy fetch', message.url, message.options)
      const resp = await fetch(message.url, {
        ...message.options,
        signal: abortController.signal,
      })
      port.postMessage({
        type: 'PROXY_RESPONSE_METADATA',
        metadata: {
          status: resp.status,
          statusText: resp.statusText,
          headers: Object.fromEntries(resp.headers.entries()),
        },
      } as ProxyFetchResponseMetadataMessage)
      for await (const chunk of streamAsyncIterable(resp.body!)) {
        port.postMessage({
          type: 'PROXY_RESPONSE_BODY_CHUNK',
          value: uint8Array2String(chunk),
          done: false,
        } as ProxyFetchResponseBodyChunkMessage)
      }
      port.postMessage({ type: 'PROXY_RESPONSE_BODY_CHUNK', done: true } as ProxyFetchResponseBodyChunkMessage)
    })
  })
}

export async function proxyFetch(tabId: number, url: string, options?: RequestInitSubset): Promise<Response> {
  console.debug('proxyFetch', tabId, url, options)
  return new Promise((resolve, reject) => {
    const port = Browser.tabs.connect(tabId, { name: uuid() })
    let settled = false
    port.onDisconnect.addListener(() => {
      if (!settled) {
        reject(new DOMException('proxy fetch aborted', 'AbortError'))
      }
    })
    options?.signal?.addEventListener('abort', () => port.disconnect())
    const { signal: _signal, ...messageOptions } = options || {}
    const body = new ReadableStream({
      start(controller) {
        port.onMessage.addListener(function onMessage(
          message: ProxyFetchResponseMetadataMessage | ProxyFetchResponseBodyChunkMessage,
        ) {
          if (message.type === 'PROXY_RESPONSE_METADATA') {
            settled = true
            const response = new Response(body, message.metadata)
            resolve(response)
          } else if (message.type === 'PROXY_RESPONSE_BODY_CHUNK') {
            if (message.done) {
              controller.close()
              port.onMessage.removeListener(onMessage)
              port.disconnect()
            } else {
              controller.enqueue(string2Uint8Array(message.value))
            }
          }
        })
        port.postMessage({ url, options: messageOptions } as ProxyFetchRequestMessage)
      },
      cancel() {
        port.disconnect()
      },
    })
  })
}
