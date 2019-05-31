const fs = require('fs');
const { spawn, execSync } = require('child_process');

const defaults =
{
	gstPath: '/usr/bin/gst-launch-1.0',
	verbose: false,
	width: 1920,
	height: 1080,
	fps: 30,
	mbps: 4,
	preset: 'superfast',
	format: 'matroska',
	output: 'stdout',
	pipewire: {
		path: null // = default
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
		this.opts = options;
		const displayServer = process.env.XDG_SESSION_TYPE.toLowerCase();

		var generateConfig = () =>
		{
			var opts = this.getOptions();

			if(!fs.existsSync(opts.gstPath))
				throw new Error(`File does not exists: ${opts.gstPath}`);

			var videoOpts = [
			'!', 'queue', 'leaky=2', 'max-size-buffers=0', 'max-size-time=0', 'max-size-bytes=0',
			'!', 'videorate',
			'!', `video/x-raw,width=${opts.width},height=${opts.height},framerate=${opts.fps}/1`,
			'!', 'videoconvert',
			'!', 'queue',
			'!', 'x264enc', 'sliced-threads=true', 'tune=zerolatency',
				`speed-preset=${opts.preset}`, `bitrate=${opts.mbps * 1024}`,
				`key-int-max=${opts.fps * 2}`,
			'!', 'h264parse',
			'!', 'video/x-h264,profile=main'
			];

			if(displayServer == 'x11')
				videoOpts.unshift('ximagesrc', 'use-damage=0', 'do-timestamp=true');
			else
				videoOpts.unshift('pipewiresrc', `path=${opts.pipewire.path}`, 'do-timestamp=true', '!');

			var extension;
			switch(opts.format)
			{
				case('matroska'):
					videoOpts.push('!', 'matroskamux', 'name=mux', 'streamable=true');
					extension = '.mkv';
					break;
				case('mp4'):
					videoOpts.push('!', 'mp4mux', 'name=mux', 'streamable=true', 'fragment-duration=1000');
					extension = '.mp4';
					break;
				default:
					throw new Error(`Unsupported format: ${opts.format}`);
			}

			var audioOpts = [
			'pulsesrc', `device=${opts.audio.device}`,
				'provide-clock=true', 'do-timestamp=true', `buffer-time=${opts.audio.buffer}`,
			'!', 'queue', 'leaky=2', 'max-size-buffers=0', 'max-size-time=0', 'max-size-bytes=0',
			'!', 'audiorate',
			'!', 'audio/x-raw,rate=48000,channels=2,depth=16',
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

			if(!opts.file.name)
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

			var stdio;
			if(opts.verbose)
			{
				if(opts.output == 'stdout')
				{
					stdio = ['inherit', 'pipe', 'inherit'];
					encodeOpts.unshift('-qe');
				}
				else
				{
					stdio = 'inherit';
					encodeOpts.unshift('-e');
				}
			}
			else
			{
				if(opts.output == 'stdout')
				{
					stdio = ['ignore', 'pipe', 'ignore'];
					encodeOpts.unshift('-qe');
				}
				else
				{
					stdio = 'ignore';
					encodeOpts.unshift('-qe');
				}
			}

			return { opts: opts, encodeOpts: encodeOpts, stdio: stdio };
		}

		this.start = () =>
		{
			if(this.process) this.stop();
			var config = generateConfig();

			this.process = spawn(config.opts.gstPath, config.encodeOpts, { stdio: config.stdio });
			this.process.once('close', () => this.process = null);
			this.process.once('error', (err) => console.log(err.message));

			if(config.opts.output == 'stdout')
				return this.process.stdout;
		}

		this.stop = () =>
		{
			try { process.kill(this.process.pid, 'SIGHUP'); }
			catch(err) { console.log(err.message); }
		}

		this.getOptions = () =>
		{
			return deepMerge(defaults, this.opts);
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
	for(var key in source)
	{
		if(source[key] instanceof Object)
			source[key] = { ...target[key], ...source[key] };
	}

	return target = { ...target, ...source };
}

module.exports = recorder;