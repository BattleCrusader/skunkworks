import sharp from 'sharp';
const base = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();
const withGps = await sharp(base).withMetadata({ exif: { IFD0: { Copyright: 'skw' }, GPS: { GPSLatitudeRef: 'S', GPSLatitude: '33/1 51/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '151/1 12/1 0/1' } } }).jpeg().toBuffer();
console.log('in bytes', withGps.length, 'hasExif', withGps.includes(Buffer.from('Exif')), 'hasGPS', withGps.includes(Buffer.from('GPS')));
const m = await sharp(withGps).metadata();
console.log('meta.exif len', m.exif?.length, 'keys', Object.keys(m).join(','));
const out = await sharp(withGps).rotate().jpeg({quality:82}).toBuffer();
const m2 = await sharp(out).metadata();
console.log('out', out.length, 'exif', m2.exif === undefined ? 'undefined' : m2.exif.length, 'hasExifMagic', out.includes(Buffer.from('Exif\0\0')), 'hasGPS', out.includes(Buffer.from('GPS')));
