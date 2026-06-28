// pkijs needs a WebCrypto engine installed once, or every digest/sign/verify throws. Import this for
// its side effect from any module that uses pkijs.
import { webcrypto } from 'node:crypto'
import * as pkijs from 'pkijs'

pkijs.setEngine('pdfx', new pkijs.CryptoEngine({ name: 'pdfx', crypto: webcrypto as Crypto }))
