// Node loader hook for the bench: hooks/*.ts import each other without extensions.
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith('.'))return n(s+'.ts',c);throw e}}`))
