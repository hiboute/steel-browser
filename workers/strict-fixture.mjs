import http from "node:http";
import dgram from "node:dgram";
let directHits = 0, proxyHits = 0, dnsHits = 0;
const direct = http.createServer((_req,res) => { directHits++; res.end("DIRECT PATH MUST NOT BE USED"); });
const proxy = http.createServer((_req,res) => { proxyHits++; res.setHeader("content-type","text/html"); res.end("<title>Owned proxy fixture</title>Via required proxy"); });
const control = http.createServer((req,res) => { if(req.url === "/stop-proxy") { proxy.closeAllConnections(); proxy.close(); } res.setHeader("content-type","application/json"); res.end(JSON.stringify({directHits,proxyHits,dnsHits})); });
const dns = dgram.createSocket("udp4"); dns.on("message",()=>dnsHits++);dns.bind(5353,"0.0.0.0");
direct.listen(8081,"0.0.0.0"); proxy.listen(8080,"0.0.0.0"); control.listen(3000,"0.0.0.0");
