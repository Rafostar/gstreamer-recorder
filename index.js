const fs = require('fs');
const path = require('path');
const { homedir } = require('os');
const { spawn, execSync } = require('child_process');
const noop = () => {};

const defaults =
{
	gstPath: '/usr/bin/gst-launch-1.0',
	output: 'stdout',
	preset: 'superfast',
	format: 'matroska',
	pipewire: {
		path: null // = default
	},
	video: {
		width: 1920,
		height: 1080,
		fps: 30,
		mbps: 4,
		scaling: false,
		borders: true
	},
	audio: {
		device: null, // = no sound
		buffer: 40000,
		encoder: null // = copy sound
	},
	server: {
		host: '127.0.0.1',
		port: 8080
	},
	file: {
		dir: '/tmp',
		name: null // = auto generated
	}
};

class recorder
{
	constructor(options)
	{
		this.process = null;

		if(!(options instanceof Object)) options = {};
		this.opts = deepMerge(defaults, options);

		const displayServer = process.env.XDG_SESSION_TYPE.toLowerCase();

		var generateConfig = () =>
		{
			var opts = this.getOptions();

			if(!fs.existsSync(opts.gstPath))
				throw new Error(`File does not exists: "${opts.gstPath}"`);

			var videoOpts = [
			'!', 'queue', 'leaky=2', 'max-size-buffers=0', 'max-size-time=0', 'max-size-bytes=0',
			'!', 'videorate',
			'!', `video/x-raw,framerate=${opts.video.fps}/1`,
			'!', 'videoconvert',
			'!', 'queue',
			'!', 'x264enc', 'sliced-threads=true', 'tune=zerolatency',
				`speed-preset=${opts.preset}`, `bitrate=${opts.video.mbps * 1000}`,
				`key-int-max=${opts.video.fps * 2}`,
			'!', 'h264parse',
			'!', 'video/x-h264,profile=main'
			];

			if(displayServer === 'x11')
				videoOpts.unshift('ximagesrc', 'use-damage=false', 'do-timestamp=true');
			else
				videoOpts.unshift('pipewiresrc', `path=${opts.pipewire.path}`, 'do-timestamp=true');

			if(opts.video.scaling)
				videoOpts.splice(videoOpts.indexOf('videoconvert') - 1, 0, '!', 'videoscale', `add-borders=${opts.video.borders}`,
					'!', `video/x-raw,width=${opts.video.width},height=${opts.video.height},pixel-aspect-ratio=1/1`);

			var isStreamable = (opts.output === 'file') ? false : true;
			var extension;
			switch(opts.format)
			{
				case('matroska'):
				case('mkv'):
					videoOpts.push('!', 'matroskamux', 'name=mux', `streamable=${isStreamable}`);
					extension = '.mkv';
					break;
				case('mp4'):
					videoOpts.push('!', 'mp4mux', 'name=mux', `streamable=${isStreamable}`, 'fragment-duration=1');
					extension = '.mp4';
					break;
				case('mpegts'):
				case('ts'):
					videoOpts.push('!', 'mpegtsmux', 'name=mux');
					extension = '.ts';
					break;
				default:
					throw new Error(`Unsupported format: ${opts.format}`);
			}

			var audioOpts = [
			'pulsesrc', `device=${opts.audio.device}`,
				'provide-clock=true', 'do-timestamp=true', `buffer-time=${opts.audio.buffer}`,
			'!', 'queue', 'leaky=2', 'max-size-buffers=0', 'max-size-time=0', 'max-size-bytes=0',
			'!', 'audiorate', 'skip-to-first=true',
			'!', 'audio/x-raw,channels=2',
			'!', 'mux.'
			];

			if(opts.audio.encoder)
			{
				var audioEncOpts = [
					'!', 'audioconvert',
					'!', 'queue',
					'!', `${opts.audio.encoder}`,
					'!', 'mux.'
				];

				audioOpts.splice(-2, 2);
				audioOpts = [...audioOpts, ...audioEncOpts];
			}

			if(opts.file.name === null)
				opts.file.name = createFilename();

			var outOpts;
			switch(opts.output)
			{
				case('stdout'):
					outOpts = ['!', 'fdsink', 'fd=1', 'sync=false'];
					break;
				case('server'):
					outOpts = ['!', 'tcpserversink',
						`host=${opts.server.host}`, `port=${opts.server.port}`, 'sync=false'];
					break;
				case('file'):
					if(!fs.existsSync(opts.file.dir))
						throw new Error(`Directory does not exists: "${opts.file.dir}"`);
					outOpts = ['!', 'filesink',
						'location=' + path.join(opts.file.dir, opts.file.name + extension), 'sync=false'];
					break;
				case('hls'):
				case('m3u'):
				case('m3u8'):
					if(!fs.existsSync(opts.file.dir))
						throw new Error(`Directory does not exists: "${opts.file.dir}"`);
					outOpts = [
						'!', 'hlssink', 'async-handling=true',
						`location=${opts.file.dir}/segment%05d${extension}`,
						`playlist-location=${opts.file.dir}/playlist.m3u8`,
						'target-duration=1', 'playlist-length=3', 'max-files=6'
					];
					break;
				default:
					throw new Error(`Unsupported output: ${opts.output}`);
			}

			var encodeOpts;
			if(opts.audio.device)
				encodeOpts = [...videoOpts, ...outOpts, ...audioOpts];
			else
				encodeOpts = [...videoOpts, ...outOpts];

			var stdio = ['ignore', 'pipe', 'pipe'];

			var launchArgs = (opts.output === 'stdout') ? '-qe' : '-e';
			encodeOpts.unshift(launchArgs);

			return { opts: opts, encodeOpts: encodeOpts, stdio: stdio };
		}

		this.start = (cb) =>
		{
			cb = cb || noop;

			if(this.process) this.stop();
			var config = generateConfig();

			this.process = spawn(config.opts.gstPath, config.encodeOpts, { stdio: config.stdio, detached: true });
			this.process.once('close', () => this.process = null);
			this.process.once('error', (err) => console.error(err.message));

			if(config.opts.output === 'stdout')
			{
				cb(null);
				return this.process.stdout;
			}
			else
			{
				var launched = false;

				var launchHandler = (data) =>
				{
					/* Prevent setting timer after launch */
					if(!launched)
					{
						clearTimeout(launchTimeout);
						launchTimeout = createLaunchTimeout();
					}
				}

				var createLaunchTimeout = () =>
				{
					return setTimeout(() =>
					{
						/* Prevent callback more than once */
						if(!launched)
						{
							launched = true;

							if(this.process)
							{
								this.process.stdout.removeListener('data', launchHandler);
								cb(null);
							}
							else
								cb(new Error('GStreamer could not start!'));
						}
					}, 1200);
				}

				var launchTimeout = createLaunchTimeout();
				this.process.stdout.on('data', launchHandler);
			}
		}

		this.stop = (cb) =>
		{
			cb = cb || noop;

			try {
				this.process.kill('SIGINT');
				cb(null);
			}
			catch(err) {
				cb(err);
			}
		}

		this.getOptions = (target, source) =>
		{
			var mgrTarget = (target instanceof Object) ? target : defaults;
			var mgrSource = (source instanceof Object) ? source : this.opts;
			var merged = deepMerge(mgrTarget, mgrSource);

			var fileDir = String(merged.file.dir);
			if(fileDir.charAt(0) === '~') fileDir = fileDir.replace('~', homedir());
			merged.file.dir = path.normalize(fileDir);

			return merged;
		}

		this.getAudioDevices = (asArray) =>
		{
			var outStr;
			var list = [];

			try {
				outStr = execSync(`pacmd list-sources | grep -e "name:"`).toString();
				list = outStr.split('name:');
			}
			catch(err) {
				console.error('Could not obtain audio devices list');
			}

			var count = 0;
			var devicesArray = [];
			var devicesObject = {};

			list.forEach(device =>
			{
				var name = device.substring(device.indexOf('<') + 1, device.indexOf('>'));
				if(name)
				{
					devicesArray.push(name);
					devicesObject['dev' + count] = name;
					count++;
				}
			});

			if(asArray === true) return devicesArray;
			else return devicesObject;
		}
	}
}

function createFilename()
{
	const date = new Date();
	return 'desktop_'
		+ date.getFullYear()
		+ '-' + ('0' + date.getMonth()).slice(-2)
		+ '-' + ('0' + date.getDate()).slice(-2)
		+ '_' + ('0' + date.getHours()).slice(-2)
		+ ':' + ('0' + date.getMinutes()).slice(-2)
		+ ':' + ('0' + date.getSeconds()).slice(-2);
}

function deepMerge(target, source)
{
	var parsedSource = {};

	for(var key in source)
	{
		if(target.hasOwnProperty(key))
		{
			if(source[key] instanceof Object)
				parsedSource[key] = deepMerge(target[key], source[key]);
			else
				parsedSource[key] = source[key];
		}
	}

	return target = { ...target, ...parsedSource };
}

module.exports = recorder;
