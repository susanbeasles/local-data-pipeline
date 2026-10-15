import {test} from 'node:test';import assert from 'node:assert/strict';import {acceptance} from '../acceptance.ts';
const check=(network:string)=>acceptance([{id:'a',name:'Alpha',namespace:'fixture',claims:[{predicate:'stores',object:'records locally'},{predicate:network,object:'Alpha'}]},{id:'b',name:'Beta',namespace:'fixture',claims:[{predicate:'reads',object:'Alpha'},{predicate:'network access',object:'disabled'}]}],[],[{from:'b',to:'a',relation:'depends-on'}]);
test('explicit network prohibition preserves fixture meaning',()=>assert.deepEqual(check('does not allow network access'),[]));
test('enabled network still fails',()=>assert.ok(check('allows network access').includes('missing network denial for Alpha')));
