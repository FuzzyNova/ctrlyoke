@ECHO off
REM ctrlyoke launcher: runs this package's bundled cli.js with the node on PATH.
node "%~dp0..\out\cli.js" %*
