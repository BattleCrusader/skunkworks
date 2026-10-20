import { packageRootHash } from '../../../app/plugins/protocol.ts';
console.log(JSON.stringify(packageRootHash(process.argv[2])));
