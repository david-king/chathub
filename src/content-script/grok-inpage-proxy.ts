import Browser from 'webextension-polyfill'
import { setupProxyExecutor } from '~services/proxy-fetch'

async function main() {
  Browser.runtime.onMessage.addListener(async (message) => {
    if (message === 'url') {
      return location.href
    }
  })

  await Browser.runtime.sendMessage({ event: 'GROK_PROXY_TAB_READY' })
}

setupProxyExecutor()
main().catch(console.error)
