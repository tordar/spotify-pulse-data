import { File as TagFile } from 'node-taglib-sharp';
import * as fs from 'fs';
const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => f.match(/\.(mp3|flac|m4a)$/i)).sort();
let fixed = 0;
for (const f of files) {
  try {
    const tf = TagFile.createFromPath(dir + f);
    if ((tf.tag.disc || 0) !== 1) {
      tf.tag.disc = 1;
      tf.save();
      console.log('Fixed:', f);
      fixed++;
    }
    tf.dispose();
  } catch(e: any) { console.error('Error', f, e.message); }
}
console.log('Done, fixed', fixed, 'files');
