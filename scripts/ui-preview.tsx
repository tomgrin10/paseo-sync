import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
const temp = "/tmp/paseo-sync-ui";
await fs.mkdir(temp, { recursive: true });
const entry = path.join(temp, "entry.tsx");
await fs.writeFile(
  entry,
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {PluginRpcProvider} from '${process.cwd()}/node_modules/@getpaseo/plugin/dist/client/host.js';
import {SyncSurface} from '${process.cwd()}/client/surface';
const theme={colors:{surface0:'#15171b',surface1:'#1e2126',surface2:'#2a2e35',border:'#3b414b',foreground:'#eceef2',foregroundMuted:'#aeb6c2',accent:'#8fb7fa',accentForeground:'#111a29',statusSuccess:'#76d6a1',statusWarning:'#e9c274',statusDanger:'#ff9a9a'}};
const row={workspaceId:'fixture',name:'Continue the release on my laptop',cwd:'/home/tom/Projects/paseo',isolation:'worktree',project:'Paseo'};
async function invoke(method,input){
if(method==='sync.hosts')return {hosts:[{target:'laptop',label:'Laptop',source:'ssh'},{target:'desktop',label:'Desktop',source:'tailscale'}]};
if(method==='sync.workspaces')return {workspaces:[row,{...row,workspaceId:'fixture2',name:'Fix workspace transfers',cwd:'/home/tom/Projects/paseo-sync'}]};
if(method==='sync.preview')return {id:'preview',workspace:row,destination:input.destination,files:42,sessions:2,bytes:5242880,branch:'release',skipped:[],mode:input.mode};
if(method==='sync.run')return {runId:'run'};
if(method==='sync.status')return {state:'done',message:'Workspace copied and verified.',result:{workspaceId:'target',cwd:'/home/tom/Projects/paseo-transfer',agents:['claude','codex'],verified:true,sourceArchived:false}};
}
const client=new QueryClient();
function App(){const [compact,setCompact]=React.useState(innerWidth<700);React.useEffect(()=>{const change=()=>setCompact(innerWidth<700);addEventListener('resize',change);return()=>removeEventListener('resize',change);},[]);return <QueryClientProvider client={client}><PluginRpcProvider invoke={invoke}><SyncSurface theme={theme} host={{id:'fixture',label:'VM'}} layout={{compact,platform:'web'}} /></PluginRpcProvider></QueryClientProvider>;}
createRoot(document.getElementById('root')).render(<App/>);
`,
);
await build({
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: path.join(temp, "bundle.js"),
  jsx: "automatic",
  alias: {
    "react-native": path.join(process.cwd(), "node_modules/react-native-web"),
    react: path.join(process.cwd(), "node_modules/react"),
    "react/jsx-runtime": path.join(
      process.cwd(),
      "node_modules/react/jsx-runtime",
    ),
  },
  nodePaths: [path.join(process.cwd(), "node_modules")],
  define: { "process.env.NODE_ENV": '"development"' },
  logLevel: "warning",
});
const html =
  '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sync preview</title><style>html,body,#root{margin:0;height:100%;background:#15171b}*:focus-visible{outline:2px solid #8fb7fa;outline-offset:2px}::selection{background:#8fb7fa;color:#111a29}*{scrollbar-color:#596271 #15171b}</style><div id="root"></div><script src="/bundle.js"></script></html>';
createServer(async (req, res) => {
  if (req.url === "/bundle.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(await fs.readFile(path.join(temp, "bundle.js")));
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  }
}).listen(8797, "0.0.0.0", () =>
  console.log("UI preview: http://127.0.0.1:8797"),
);
