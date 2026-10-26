import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const label='com.codex.douyin-monitor-workbench.public-replica-publisher';
const path=join(homedir(),'Library','LaunchAgents',label+'.plist');
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
try{await lstat(path);throw Error('publisher-already-installed');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(join(homedir(),'Library','LaunchAgents'),{recursive:true});
const data=join(root,'data');
const env={DATA_DIR:data,TZ:'Asia/Shanghai'};
for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])if(process.env[key])env[key]=process.env[key];
const log=join(data,'public-replica-publisher','runtime.log');
const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>--use-env-proxy</string><string>${esc(join(root,'scripts','public-replica-publisher.mjs'))}</string></array>
<key>WorkingDirectory</key><string>/</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${k}</key><string>${esc(v)}</string>`).join('')}</dict>
<key>StandardOutPath</key><string>${esc(log)}</string><key>StandardErrorPath</key><string>${esc(log)}</string></dict></plist>`;
await writeFile(path,plist,{flag:'wx',mode:0o600});
execFileSync('plutil',['-lint',path],{stdio:'ignore'});
execFileSync('launchctl',['bootstrap',`gui/${process.getuid()}`,path],{stdio:'ignore'});
console.log(JSON.stringify({installed:true,label,runtimeAI:false,collectionScheduleChanged:false}));
