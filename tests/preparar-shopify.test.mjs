import assert from 'node:assert/strict'
import { refsVoltra } from '../src/lib/prepararShopify.js'
assert.deepEqual(refsVoltra([{ n_referencia: 'VT-1003' }, { n_referencia: 'VT-1003' }, { n_referencia: '2071' }, { n_referencia: 'FW-5' }, {}]), ['VT-1003'])
assert.deepEqual(refsVoltra(null), [])
console.log('✓ solo se mandan a Shopify las referencias de Voltra, sin duplicar')
