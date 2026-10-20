import sharp from 'sharp';

function gpsExifApp1({ lat = [33,51,0], latRef = 'S', lon = [151,12,0], lonRef = 'E' } = {}) {
  const be32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const be16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
  const rat = (nums) => Buffer.concat(nums.map((n) => Buffer.concat([be32(n), be32(1)])));
  const ifd0 = Buffer.concat([be16(1), Buffer.concat([be16(0x8825), be16(4), be32(1), be32(26)]), be32(0)]);
  const latOff = 26 + 2 + 4 * 12 + 4;
  const lonOff = latOff + 24;
  const gps = Buffer.concat([
    be16(4),
    Buffer.concat([be16(0x0001), be16(2), be32(2), Buffer.from([latRef.charCodeAt(0), 0, 0, 0])]),
    Buffer.concat([be16(0x0002), be16(5), be32(3), be32(latOff)]),
    Buffer.concat([be16(0x0003), be16(2), be32(2), Buffer.from([lonRef.charCodeAt(0), 0, 0, 0])]),
    Buffer.concat([be16(0x0004), be16(5), be32(3), be32(lonOff)]),
    be32(0),
    rat(lat), rat(lon),
  ]);
  const tiff = Buffer.concat([Buffer.from('MM'), be16(0x2a), be32(8), ifd0, gps]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), len, body]);
}
const base = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg({ quality: 95 }).toBuffer();
const inj = Buffer.concat([base.subarray(0, 2), gpsExifApp1(), base.subarray(2)]);
const m = await sharp(inj).metadata();
console.log('input has exif', m.exif && m.exif.length, 'magic', inj.includes(Buffer.from('Exif\0\0')), 'len', inj.length);
// parse tags back
const t = m.exif.subarray(6);
const ifd0 = t.readUInt32BE(4); const n = t.readUInt16BE(ifd0);
console.log('ifd0 n', n, 'tag', '0x'+t.readUInt16BE(ifd0+2).toString(16), 'gpsptr', t.readUInt32BE(ifd0+2+8));
const g = t.readUInt32BE(ifd0+2+8); console.log('gps entries', t.readUInt16BE(g));
const out = await sharp(inj).rotate().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
const m2 = await sharp(out).metadata();
console.log('out exif', m2.exif === undefined ? 'undefined' : m2.exif.length, 'hasMagic', out.includes(Buffer.from('Exif\0\0')));
const plainOut = await sharp(base).rotate().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
console.log('identical to no-exif encode:', out.equals(plainOut));
