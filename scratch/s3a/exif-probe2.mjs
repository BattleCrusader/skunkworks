import sharp from 'sharp';
const base = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg({ quality: 95 }).toBuffer();
const withGps = await sharp(base).withMetadata({ exif: { IFD0: { Copyright: 'skw' }, GPS: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 0/1' } } }).jpeg({ quality: 95 }).toBuffer();
const plain = base;
const enc = async (b) => sharp(b).rotate().jpeg({ quality: 82, mozjpeg: true }).toBuffer();
const [a, b2] = [await enc(withGps), await enc(plain)];
console.log('identical outputs:', a.equals(b2), a.length, b2.length);
const m = await sharp(withGps).metadata();
console.log('exif bytes', m.exif && m.exif.length, 'tiff starts', m.exif && m.exif.subarray(0,4).toString('hex'));
// look for GPS ifd pointer 0x8825 in IFD0
const e = m.exif;
const tiff = e.subarray(6); // after "Exif\0\0"
const le = tiff.readUInt16LE(0) === 0x2a;
const ifd0 = tiff.readUInt32LE(4);
const n = tiff.readUInt16LE(ifd0);
const tags = [];
for (let i = 0; i < n; i++) { const o = ifd0 + 2 + i*12; tags.push('0x'+tiff.readUInt16LE(o).toString(16)); }
console.log('le', le, 'ifd0 entries', n, tags.join(','));
