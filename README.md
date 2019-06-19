# gstreamer-recorder
GStreamer wrapper for recording desktop.

Requires [GStreamer-1.0](https://gstreamer.freedesktop.org) with `gst-launch-1.0` binary and following GStreamer1 plugins: base, good, bad, ugly.

Used by [GNOME Shell Extension Cast to TV](https://github.com/Rafostar/gnome-shell-extension-cast-to-tv) and [gst-rec](https://github.com/Rafostar/gst-rec) terminal app.

## Examples
Record desktop directly to file:
```
var gstRecorder = require('gstreamer-recorder');
var recorder = new gstRecorder({
  output: 'file',
  format: 'mp4',
  file: {
    dir: '/tmp',
    name: 'My Recording'
  }
});
var duration = 10000;

recorder.start();

console.log(`Recording ${duration/1000} sec video to ${recorder.opts.file.dir}`);
setTimeout(() => recorder.stop(), duration);
```

Pipe output:
```
var fs = require('fs');
var gstRecorder = require('gstreamer-recorder');
var recorder = new gstRecorder({ output: 'stdout', format: 'matroska' });
var destFile = '/tmp/recording.mkv';
var duration = 10000;
var writableStream = fs.createWriteStream(destFile);

recorder.start().pipe(writableStream);

console.log(`Piping output to ${destFile} for ${duration/1000} seconds`);
setTimeout(() => recorder.stop(), duration);
```

Create tcp server:
```
var gstRecorder = require('gstreamer-recorder');
var recorder = new gstRecorder({ output: 'server', server: { port: 8080 }});

recorder.start();
console.log(`Started tcp media server on port ${recorder.opts.server.port}`);

process.on('SIGINT', () => recorder.stop());
process.on('SIGTERM', () => recorder.stop());
```
