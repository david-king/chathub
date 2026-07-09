import Browser, { Runtime } from 'webextension-polyfill'
import { proxyFetch } from '~services/proxy-fetch'
import { RequestInitSubset } from '~types/messaging'

const GROK_HOME_URL = 'https://grok.com/'
const GROK_PROXY_READY_EVENT = 'GROK_PROXY_TAB_READY'

class GrokWebClient {
  private async findExistingProxyTab() {
    const tabs = await Browser.tabs.query({ url: 'https://grok.com/*' })
    return tabs.find((tab) => tab.id !== undefined)
  }

  private waitForProxyTabReady(): Promise<Browser.Tabs.Tab> {
    return new Promise((resolve, reject) => {
      const listener = async (message: any, sender: Runtime.MessageSender) => {
        if (message?.event !== GROK_PROXY_READY_EVENT || !sender.tab) {
          return
        }
        Browser.runtime.onMessage.removeListener(listener)
        clearTimeout(timer)
        resolve(sender.tab)
        return true
      }

      const timer = setTimeout(() => {
        Browser.runtime.onMessage.removeListener(listener)
        reject(new Error('Timeout waiting for Grok tab. Please open grok.com and finish browser verification.'))
      }, 15 * 1000)

      Browser.runtime.onMessage.addListener(listener)
    })
  }

  private async createProxyTab() {
    const readyPromise = this.waitForProxyTabReady()
    await Browser.tabs.create({ url: GROK_HOME_URL, pinned: true })
    return readyPromise
  }

  private async getProxyTab() {
    let tab = await this.findExistingProxyTab()
    if (!tab) {
      tab = await this.createProxyTab()
    }
    return tab
  }

  private async refreshProxyTab() {
    const tab = await this.findExistingProxyTab()
    if (!tab?.id) {
      return this.createProxyTab()
    }
    const readyPromise = this.waitForProxyTabReady()
    await Browser.tabs.reload(tab.id)
    return readyPromise
  }

  async fetch(path: string, options?: RequestInitSubset) {
    let tab = await this.getProxyTab()
    let response = await proxyFetch(tab.id!, new URL(path, GROK_HOME_URL).toString(), options)

    // A stale Cloudflare/browser session often recovers after a real grok.com reload.
    if (response.status === 403) {
      tab = await this.refreshProxyTab()
      response = await proxyFetch(tab.id!, new URL(path, GROK_HOME_URL).toString(), options)
    }

    return response
  }
}

export const grokWebClient = new GrokWebClient()
