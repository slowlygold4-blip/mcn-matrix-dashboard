import {getPriority,setPriority} from 'node:os';
/** Lower only this process, never raise an already quieter worker. */
export function ensureBackgroundPriority({read=getPriority,write=setPriority}={}){
 try{const current=read();if(current<10)write(10);return {status:'applied',priority:read()};}
 catch{return {status:'deferred',priority:null};}
}
