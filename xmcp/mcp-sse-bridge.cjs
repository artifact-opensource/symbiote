const { spawn } = require('child_process');
const express = require('express');
const { SSETransport } = require('@modelcontextprotocol/sdk/server/sse.js');

const app = express();
const port = 3000;

app.get('/sse', async (req, res) => {
    console.log('New MCP SSE connection established via HTTP');
    
    const serverProcess = spawn('node', [
        '/opt/ava/mach6/mach6-core/dist/tools/mcp-server.js', 
        '--config', 
        '/opt/ava/mach6/symbiote.json'
    ]);

    const transport = new SSETransport('/messages', res);
    
    serverProcess.stdout.on('data', (data) => {
        transport.send(data.toString());
    });

    serverProcess.stderr.on('data', (data) => {
        console.error(`MCP Server Error: ${data}`);
    });

    req.on('close', () => {
        serverProcess.kill();
    });
});

app.post('/messages', express.text(), async (req, res) => {
    res.status(202).send('Accepted');
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Mach6 MCP SSE Bridge running at http://0.0.0.0:${port}/sse`);
});
