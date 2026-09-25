@ECHO off
REM ctrlyoke launcher: runs this package's bundled mcp-server.js with the node on PATH.
node "%~dp0..\out\mcp-server.js" %*
