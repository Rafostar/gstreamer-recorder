const fs = require('fs');
const { spawn, execSync } = require('child_process');

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
				`speed-preset=${opts.preset}`, `bitrate=${opts.video.mbps * 1024}`,
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
					videoOpts.push('!', 'matroskamux', 'name=mux', `streamable=${isStreamable}`);
					extension = '.mkv';
					break;
				case('mp4'):
					videoOpts.push('!', 'mp4mux', 'name=mux', `streamable=${isStreamable}`, 'fragment-duration=1');
					extension = '.mp4';
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
						`location=${opts.file.dir}/${opts.file.name}${extension}`, 'sync=false'];
					break;
				default:
					throw new Error(`Unsupported output: ${opts.output}`);
			}

			var encodeOpts;
			if(opts.audio.device)
				encodeOpts = [...videoOpts, ...outOpts, ...audioOpts];
			else
				encodeOpts = [...videoOpts, ...outOpts];

			var stdOpt = (opts.output === 'stdout') ? 'pipe' : 'ignore';
			var stdio = ['ignore', stdOpt, 'inherit'];
			encodeOpts.unshift('-qe');

			return { opts: opts, encodeOpts: encodeOpts, stdio: stdio };
		}

		this.start = () =>
		{
			if(this.process) this.stop();
			var config = generateConfig();

			this.process = spawn(config.opts.gstPath, config.encodeOpts, { stdio: config.stdio, detached: true });
			this.process.once('close', () => this.process = null);
			this.process.once('error', (err) => console.error(err.message));

			if(config.opts.output === 'stdout')
				return this.process.stdout;
		}

		this.stop = () =>
		{
			try { this.process.kill('SIGINT'); }
			catch(err) { console.error(err.message); }
		}

		this.getOptions = (target, source) =>
		{
			var mgrTarget = (target instanceof Object) ? target : defaults;
			var mgrSource = (source instanceof Object) ? source : this.opts;

			return deepMerge(mgrTarget, mgrSource);
		}

		this.getAudioDevices = (asArray) =>
		{
			var outStr = execSync(`pacmd list-sources | grep -e "name:"`).toString();
			var list = outStr.split('name:');

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
