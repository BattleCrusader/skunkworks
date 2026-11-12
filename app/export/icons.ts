/**
 * The export trees' icon bytes.
 *
 * A static or Astro tree has no server: whatever a document names has to be a file in the tree. The
 * document names `/favicon.svg` and `/apple-touch-icon.png` because the live shell does, and the two
 * are compared byte for byte (`test/export-targets`), so both files ship.
 *
 * Why a constant and not a raster at export time: `planStatic()` and `planAstro()` are synchronous
 * (the projection is read once, the planners only lay it out), and `sharp` is promise-only. A blob
 * beside the SVG it is the raster of is the honest alternative — and it is the same mark the static
 * tree has always carried, so an export still has an icon before a tenant has artwork of its own.
 *
 * `EXPORT_APPLE_TOUCH_PNG` is 180x180, generated from `EXPORT_MARK_SVG` at density 405 (librsvg's
 * default 72 dpi at a 32-unit viewBox would be a 32 px render upscaled into a blur).
 */
export const EXPORT_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0B1F33"/><rect x="7" y="9" width="12" height="3" fill="#F7F5F2"/><rect x="7" y="15" width="8" height="3" fill="#F7F5F2"/><circle cx="23" cy="22" r="4" fill="#B4400F"/></svg>';

/** 180x180 PNG, base64: what `/apple-touch-icon.png` is in an exported tree. */
export const EXPORT_APPLE_TOUCH_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAAACXBIWXMAAD5JAAA+SQE1IK/ZAAAE/klEQVR42u3d22uXZQDA' +
  'ce+zdnKzzbm5ozvvt5Pm3AnDiijK0LKrLCW8idGEKIaVCQlGQnak6CCrLpJCrb8m/4sgunx6nsFAar928Le977s+Fx92/+O7' +
  'l+d9n9OuB1rHAuwUu/wICBoEDYIGQSNoEDQIGgQNgkbQIGgQNAgaBI2gQdAgaBA0CBpBg6BB0CBoEDSCBkGDoEHQIGgEDYIG' +
  'QYOgQdAIGgQNggZBI2g/BIIGQYOgQdAIGgQNggZBg6ARdI4ce+5MODe/SHT61QXBFj3ob3+8Gf768w+i3+/eFaygBS1oQQta' +
  '0IIWtKAFLWhBCxpBC1rQgha0oAUtaEELWtCCFjSCFrSgBS1oQQta0IIWtKAFLWgKFPSpV+bDpavXiRYuXhGsLVgIGgQNggZB' +
  'g6ARNAgaBA2CBkEjaBA0CBoEDYJG0Nk4f+Ht5V0rRZJuHRCWoHfMFqx0fYSwBC1oBC1oBC1oQQta0IIWNIIWNIIWNIIWtKAF' +
  'LWhBCxpBCxpBCxpBC1rQgha0oAWNoEtzJ8JjJ88WStvY8dz+ng8eGA3D3f3hmcGucH6kNSyO7wuXDzWFK4cbw7sTTeHN8ebw' +
  'cqktPN7fHTo6hgRN/lTFiOd6e8LFiX3h5kxN+G2uat1uTNWF10ZbQin+EwiaTNW2jYYXhjrC0nTdhiIu5+MjDeFY38GwW9Bs' +
  't5ne3nCjQiGvFvZwjp/Ygt5B9raXwqVDjVsS8r3uzFaHM3GsncbkgmZL9HYNhu+m6rY85null8n6thFBU1mjB/vDTxt84auU' +
  'Tyfrw772YUFTuSdzVjGv+DxG3ZCTJ7WgC6y1Yzj8MF2bacwrPnjk4fBQDsbUgi6oFM+HMaI8xLzi3MgBQbM5L8WvDHmKOfk1' +
  'SuN5QbMh7Z1D4ZfZmtwFnXwRx9NVraOCZv3emmjOZcwrnhroEjTrfzrfjhMbeQ7666N7MntBFHTBpFVyeY55xVRPj6BZ+8vG' +
  '0nRdIYJOwyJBs+aMYBFiTn6eqc7k5VDQPtVtmZGDfYKmvMuHmwoV9Om4HlvQlPXN1J5CBf362H5BU/6F8E7OP9f909U4NS9o' +
  'VpXWHRcp5uXdLZMNgmZ1LXFlXdGCThMsgmZVTe3FCzqt6xA0ZXdxFy3oa0f2Cpryst6ZslHvxENsBE1ZH8UnXpGCzmLBv6AL' +
  'ZCF+1y1S0OlIMUFT1hMxkCIF3dxREjTlpeMCijK58lkGXzgEXUDvH24sRNAvDrcLmrUd78v/sOPWXPXyRJCgCes54znNwOU5' +
  '6AsZLEoSdIGlTai5fTrHMX7a9yho1i2d0Xwtp9+kz5YOOJeDzZ1pl7ezOb48Wr88RS9oNuXZgc7cxJz+ufq7BhwFxv2ZH2vJ' +
  '/giw2arwaLyuwumjVOSrx2K8ECjL8+xODHYG50NT0aizeFKnE5yezvDYL0HvcKfik/LWNk2NL03VhvEMjikQ9P/MULyhKq2j' +
  '2MqY052HTe2l4BYstm2H+Ml4Jsb3FT427JO46XWypze4p5BM1MSw06e96/FuwfsZJ78Xd55Mx9tod7e6SZac6O4cDM8PdsR7' +
  'DJv+81LOtLDoqzhB8sb4/vBkXH+d16GFoPnXptvOGPlg90B8uesPA/FvW1whl+Xp+4IGQSNoEDQIGgQNgkbQIGgQNAgaBI2g' +
  'QdAgaBA0ggZBg6BB0CBoBA2CBkGDoEHQCBoEDYIGQYOgETQIGjL1N1A4r3PCIlTVAAAAAElFTkSuQmCC',
  'base64',
);
