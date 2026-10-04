import { describe, expect, it } from 'vitest'
import { isPlainHttpRemoteBaseUrl } from './openai-compatible.ts'

describe('isPlainHttpRemoteBaseUrl', () => {
  it('warns about plain http to LAN, VPN and named hosts', () => {
    for (const value of [
      'http://192.168.1.5:1234/v1',
      'http://100.64.0.1:11434/v1',
      'http://homelab.local:8080/v1',
      'http://localhost.localdomain:1234/v1',
    ]) {
      expect(isPlainHttpRemoteBaseUrl(value), value).toBe(true)
    }
  })

  it('stays quiet for every loopback host, https, and unparseable input', () => {
    for (const value of [
      'http://localhost:1234/v1/',
      'http://127.0.0.1:11434/v1',
      'http://127.0.0.2:8080/v1',
      'http://[::1]:1234/v1',
      'https://192.168.1.5/v1',
      'not a url',
    ]) {
      expect(isPlainHttpRemoteBaseUrl(value), value).toBe(false)
    }
  })
})
