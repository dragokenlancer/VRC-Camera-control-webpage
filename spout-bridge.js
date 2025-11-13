const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { getLocalIP } = require('./utils');

// Configuration
const SPOUT_PORT = 8888;
const SPOUT_SENDER_NAME = process.env.SPOUT_SENDER || 'VRCSender1';

// Capture mode: 'camera' for OBS Virtual Camera, 'stream' for HTTP stream
const CAPTURE_MODE = process.env.CAPTURE_MODE || 'camera'; // 'camera' or 'stream'
const STREAM_URL = process.env.STREAM_URL || 'https://stream.vrcdn.live/live/';

let currentFrameBuffer = null;
let captureProcess = null;
let captureInterval = null;

// Try to find OBS Virtual Camera or use alternative capture method
function findCaptureMethod() {
  // Since OBS can see the Spout sender, we can:
  // 1. Use OBS Virtual Camera (if OBS is running with Spout source)
  // 2. Use a simple screen capture of the Spout preview window
  // 3. Use window capture if VRChat shows a preview
  
  // For now, let's try to capture from OBS Virtual Camera
  // OBS creates a virtual camera when you add a Spout source
  const virtualCameraNames = [
    'OBS Virtual Camera',
    'OBS-Camera',
    'OBS Virtual Camera (DirectShow)'
  ];
  
  return {
    method: 'obs-virtual-camera',
    deviceNames: virtualCameraNames
  };
}

// Start capture from HTTP stream
function startStreamCapture() {
  const { execSync } = require('child_process');
  let ffmpeg = null;
  
  const possibilities = [
    'ffmpeg',
    'ffmpeg.exe',
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'FFmpeg\\bin\\ffmpeg.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'FFmpeg\\bin\\ffmpeg.exe'),
  ];

  for (const ffmpegPath of possibilities) {
    try {
      execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore' });
      ffmpeg = ffmpegPath;
      console.log(`Found ffmpeg at: ${ffmpeg}`);
      break;
    } catch (e) {
      // Try next
    }
  }
  
  if (!ffmpeg) {
    console.error('FFmpeg not found. Install FFmpeg to use stream capture.');
    return false;
  }
  
  try {
    console.log(`Capturing from stream: ${STREAM_URL}`);
    
    const args = [
      '-i', STREAM_URL,
      '-c:v', 'mjpeg',
      '-q:v', '5',
      '-s', '1280x720',
      '-r', '30',
      '-f', 'mjpeg',
      '-timeout', '5000000', // 5 second timeout for network
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
      'pipe:1'
    ];
    
    captureProcess = spawn(ffmpeg, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true
    });

    let frameCount = 0;
    let buffer = Buffer.alloc(0);
    
    // MJPEG stream parser
    captureProcess.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      
      let startIndex = 0;
      
      while (startIndex < buffer.length) {
        const jpegStart = buffer.indexOf(Buffer.from([0xFF, 0xD8]), startIndex);
        if (jpegStart === -1) {
          buffer = buffer.slice(startIndex);
          break;
        }
        
        const jpegEnd = buffer.indexOf(Buffer.from([0xFF, 0xD9]), jpegStart + 2);
        if (jpegEnd === -1) {
          buffer = buffer.slice(jpegStart);
          break;
        }
        
        const frameEnd = jpegEnd + 2;
        const frame = buffer.slice(jpegStart, frameEnd);
        currentFrameBuffer = frame;
        frameCount++;
        startIndex = frameEnd;
      }
      
      if (startIndex < buffer.length) {
        buffer = buffer.slice(startIndex);
      } else {
        buffer = Buffer.alloc(0);
      }
    });

    captureProcess.stderr.on('data', (data) => {
      const msg = data.toString('utf-8').trim();
      if (msg && !msg.includes('frame=') && !msg.includes('fps=') && !msg.includes('bitrate=')) {
        if (msg.includes('error') || msg.includes('Error') || msg.includes('Failed') || msg.includes('Connection')) {
          console.error(`[FFmpeg Stream] ${msg}`);
        }
      }
    });

    captureProcess.on('error', (err) => {
      console.error('Stream capture process error:', err);
      captureProcess = null;
    });

    captureProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Stream capture process exited with code ${code}`);
        console.log('Attempting to reconnect...');
        // Auto-reconnect after 2 seconds
        setTimeout(() => {
          if (CAPTURE_MODE === 'stream') {
            startStreamCapture();
          }
        }, 2000);
      }
      captureProcess = null;
    });

    console.log('✓ Stream capture started');
    return true;
  } catch (err) {
    console.error('Failed to start stream capture:', err);
    return false;
  }
}

// Try direct Spout capture from VRCSender1 via dshow
function tryDirectSpoutCapture(ffmpeg) {
  try {
    console.log(`\n[1/3] Attempting direct Spout capture from ${SPOUT_SENDER_NAME}...`);
    
    const videoInput = `video=${SPOUT_SENDER_NAME}`;
    const fullCommand = `"${ffmpeg}" -f dshow -rtbufsize 200M -framerate 30 -i ${videoInput} -c:v mjpeg -q:v 5 -s 1280x720 -r 30 -f mjpeg pipe:1`;
    
    console.log(`FFmpeg command: ${fullCommand}`);
    
    captureProcess = spawn(fullCommand, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true
    });

    let frameCount = 0;
    let buffer = Buffer.alloc(0);
    let hasReceivedFrames = false;
    let errorOccurred = false;
    
    // Set a timeout to detect if capture fails
    const testTimeout = setTimeout(() => {
      if (!hasReceivedFrames && captureProcess) {
        console.log(`⚠️  No frames received from ${SPOUT_SENDER_NAME} after 3 seconds`);
        errorOccurred = true;
        if (captureProcess) captureProcess.kill();
      }
    }, 3000);
    
    // MJPEG stream parser
    captureProcess.stdout.on('data', (chunk) => {
      hasReceivedFrames = true;
      clearTimeout(testTimeout);
      buffer = Buffer.concat([buffer, chunk]);
      
      let startIndex = 0;
      
      while (startIndex < buffer.length) {
        const jpegStart = buffer.indexOf(Buffer.from([0xFF, 0xD8]), startIndex);
        if (jpegStart === -1) {
          buffer = buffer.slice(startIndex);
          break;
        }
        
        const jpegEnd = buffer.indexOf(Buffer.from([0xFF, 0xD9]), jpegStart + 2);
        if (jpegEnd === -1) {
          buffer = buffer.slice(jpegStart);
          break;
        }
        
        const frameEnd = jpegEnd + 2;
        const frame = buffer.slice(jpegStart, frameEnd);
        currentFrameBuffer = frame;
        frameCount++;
        startIndex = frameEnd;
      }
      
      if (startIndex < buffer.length) {
        buffer = buffer.slice(startIndex);
      } else {
        buffer = Buffer.alloc(0);
      }
    });

    captureProcess.stderr.on('data', (data) => {
      const msg = data.toString('utf-8').trim();
      if (msg && (msg.includes('error') || msg.includes('Error') || msg.includes('Failed') || msg.includes('I/O error'))) {
        console.error(`[FFmpeg Spout] ${msg}`);
        errorOccurred = true;
      }
    });

    captureProcess.on('error', (err) => {
      console.error(`[FFmpeg Spout] Process error: ${err.message}`);
      errorOccurred = true;
      captureProcess = null;
    });

    captureProcess.on('exit', (code) => {
      clearTimeout(testTimeout);
      if (code !== 0 && code !== null) {
        console.log(`✗ Direct Spout capture failed (exit code ${code})`);
        errorOccurred = true;
      }
      if (!hasReceivedFrames) {
        errorOccurred = true;
      }
      captureProcess = null;
    });
    
    // Wait a moment to see if it works
    return new Promise((resolve) => {
      setTimeout(() => {
        if (hasReceivedFrames && !errorOccurred && captureProcess) {
          console.log(`✓ Direct Spout capture from ${SPOUT_SENDER_NAME} working!`);
          resolve(true);
        } else {
          if (captureProcess) {
            captureProcess.kill();
            captureProcess = null;
          }
          console.log(`✗ Direct Spout capture failed, trying next method...`);
          resolve(false);
        }
      }, 2000);
    });
  } catch (err) {
    console.error('Failed to start direct Spout capture:', err);
    return Promise.resolve(false);
  }
}

// Start capture with fallback priority: Spout -> Stream -> OBS -> Desktop
function startSpoutCapture() {
  // Check if manual mode override is set
  if (CAPTURE_MODE === 'stream') {
    console.log('Starting HTTP stream capture (manual mode override)...');
    console.log(`Stream URL: ${STREAM_URL}`);
    return startStreamCapture();
  }
  
  if (CAPTURE_MODE === 'obs') {
    console.log('Starting OBS Virtual Camera capture (manual mode override)...');
    return startOBSCameraCaptureMode();
  }
  
  // Auto mode: try methods in priority order
  console.log('Starting capture with automatic fallback...');
  console.log(`Priority: 1. Direct Spout (${SPOUT_SENDER_NAME}) → 2. HTTP Stream → 3. OBS Virtual Camera → 4. Desktop`);
  
  // Find FFmpeg first
  const { execSync } = require('child_process');
  let ffmpeg = null;
  
  const possibilities = [
    'ffmpeg',
    'ffmpeg.exe',
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'FFmpeg\\bin\\ffmpeg.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'FFmpeg\\bin\\ffmpeg.exe'),
  ];

  for (const ffmpegPath of possibilities) {
    try {
      execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore' });
      ffmpeg = ffmpegPath;
      console.log(`Found ffmpeg at: ${ffmpeg}`);
      break;
    } catch (e) {
      // Try next
    }
  }
  
  if (!ffmpeg) {
    console.error('FFmpeg not found. Install FFmpeg to use video capture.');
    return false;
  }
  
  // Try methods in order
  return tryDirectSpoutCapture(ffmpeg).then(success => {
    if (success) return true;
    
    // Try 2: HTTP Stream
    console.log(`\n[2/3] Attempting HTTP stream capture from ${STREAM_URL}...`);
    if (startStreamCapture()) {
      // Check if stream actually works (give it a moment)
      return new Promise((resolve) => {
        setTimeout(() => {
          if (currentFrameBuffer && currentFrameBuffer.length > 0) {
            console.log('✓ HTTP stream capture working!');
            resolve(true);
          } else {
            console.log('✗ HTTP stream capture failed, trying next method...');
            if (captureProcess) {
              captureProcess.kill();
              captureProcess = null;
            }
            resolve(false);
          }
        }, 3000);
      });
    }
    return Promise.resolve(false);
  }).then(success => {
    if (success) return true;
    
    // Try 3: OBS Virtual Camera
    console.log(`\n[3/3] Attempting OBS Virtual Camera capture...`);
    const obsResult = startOBSCameraCaptureMode(ffmpeg);
    if (obsResult) {
      return Promise.resolve(true);
    }
    
    // Final fallback: Desktop capture
    console.log(`\n[4/4] All methods failed, falling back to desktop capture...`);
    return Promise.resolve(startDesktopCapture(ffmpeg));
  });
}

// OBS Virtual Camera capture mode (extracted for reuse)
function startOBSCameraCaptureMode(ffmpegParam) {
  // If ffmpeg not provided, try to find it
  let ffmpeg = ffmpegParam;
  
  if (!ffmpeg) {
    const { execSync } = require('child_process');
    const possibilities = [
      'ffmpeg',
      'ffmpeg.exe',
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'FFmpeg\\bin\\ffmpeg.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'FFmpeg\\bin\\ffmpeg.exe'),
    ];

    for (const ffmpegPath of possibilities) {
      try {
        execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore' });
        ffmpeg = ffmpegPath;
        console.log(`Found ffmpeg at: ${ffmpeg}`);
        break;
      } catch (e) {
        // Try next
      }
    }
    
    if (!ffmpeg) {
      console.error('FFmpeg not found. Install FFmpeg to use OBS Virtual Camera capture.');
      console.error('Falling back to desktop capture...');
      return startDesktopCapture(null);
    }
  }
  
  const { execSync } = require('child_process');
  
  // Try to list video devices and find OBS Virtual Camera
  try {
    console.log('Scanning for video devices...');
    const output = execSync(`"${ffmpeg}" -f dshow -list_devices true -i dummy 2>&1`, { encoding: 'utf-8' });
    const lines = output.split('\n');
    let obsCamera = null;
    let inVideoSection = false;
    const allDevices = [];
    
    // Debug: show raw output if no devices found
    let foundVideoSection = false;
    
    for (const line of lines) {
      // Check for video section start - some FFmpeg versions don't have this header
      if (line.includes('DirectShow video devices') || line.includes('video devices')) {
        inVideoSection = true;
        foundVideoSection = true;
        continue;
      }
      // Check for audio section (end of video section)
      if (line.includes('DirectShow audio devices') || line.includes('audio devices')) {
        inVideoSection = false;
        if (foundVideoSection) break; // We've processed video section
      }
      
      // If we see a dshow line with "(video)", we're in the video section
      if (line.includes('[dshow') && line.includes('(video)')) {
        inVideoSection = true;
        foundVideoSection = true;
      }
      
      // Process video devices - look for lines with [dshow and "(video)"
      if (inVideoSection || (line.includes('[dshow') && line.includes('(video)'))) {
        // Match format: [dshow @ 0x...] "Device Name" (video)
        // The device name is between quotes, before (video)
        let match = line.match(/\[dshow[^\]]*\]\s*"(.*?)"\s*\(video\)/);
        if (!match) {
          // Try format without (video): [dshow @ 0x...] "Device Name"
          match = line.match(/\[dshow[^\]]*\]\s*"(.*?)"/);
        }
        if (!match) {
          // Try generic format: [anything] "Device Name"
          match = line.match(/\[.*?\]\s*"(.*?)"/);
        }
        
        if (match) {
          const deviceName = match[1].trim();
          if (deviceName && deviceName.length > 0 && !deviceName.startsWith('@device')) {
            // Skip alternative names (they start with @device)
            allDevices.push(deviceName);
            
            // Try multiple patterns for OBS Virtual Camera
            const lowerName = deviceName.toLowerCase();
            if ((lowerName.includes('obs') && lowerName.includes('virtual') && !lowerName.includes('lovense')) ||
                (lowerName === 'obs virtual camera') ||
                (lowerName.startsWith('obs virtual') && !lowerName.includes('lovense'))) {
              // Prefer "OBS Virtual Camera" over "Lovense OBS Virtual Camera"
              if (!obsCamera || lowerName === 'obs virtual camera') {
                obsCamera = deviceName;
                console.log(`✓ Found OBS Virtual Camera: ${deviceName}`);
              }
            }
          }
        }
      }
    }
    
    // Always show all devices for debugging
    if (allDevices.length > 0) {
      console.log(`\nFound ${allDevices.length} video device(s):`);
      allDevices.forEach((dev, i) => {
        const lowerDev = dev.toLowerCase();
        const marker = (lowerDev.includes('obs') || lowerDev.includes('virtual')) ? '🎯' : '  ';
        console.log(`  ${marker} ${i + 1}. ${dev}`);
      });
      console.log('');
    } else {
      console.warn('⚠️  No video devices detected!');
      console.warn('   This might mean:');
      console.warn('   - No cameras are connected');
      console.warn('   - OBS Virtual Camera is not started');
      console.warn('   - FFmpeg cannot access DirectShow devices');
      console.warn('\n   Raw FFmpeg output (first 20 lines):');
      lines.slice(0, 20).forEach((line, i) => {
        if (line.trim()) console.log(`   ${i + 1}: ${line}`);
      });
      console.log('');
    }
    
    if (obsCamera) {
      return startOBSCameraCapture(ffmpeg, obsCamera);
    } else {
      console.warn('⚠️  OBS Virtual Camera not found in device list.');
      console.warn('   Make sure:');
      console.warn('   1. OBS Studio is running');
      console.warn('   2. Virtual Camera is started (Tools → Start Virtual Camera)');
      console.warn('   3. The device name matches one of the patterns above');
      console.warn('\n   If you see OBS in the device list above, you can manually specify it:');
      console.warn('   OBS_CAMERA="Device Name" node spout-bridge.js\n');
      
      // Try to use manual override if set
      const manualCamera = process.env.OBS_CAMERA;
      if (manualCamera) {
        console.log(`Using manual camera override: ${manualCamera}`);
        return startOBSCameraCapture(ffmpeg, manualCamera);
      }
      
      console.warn('   OBS Virtual Camera not available, falling back to desktop capture...\n');
      return startDesktopCapture(ffmpeg);
    }
  } catch (err) {
    console.error('Error detecting cameras:', err.message);
    console.log('Falling back to desktop capture...\n');
    return startDesktopCapture(ffmpeg);
  }
}

// Capture from OBS Virtual Camera
function startOBSCameraCapture(ffmpeg, cameraName) {
  try {
    console.log(`Capturing from: ${cameraName}`);
    
    // For dshow on Windows, construct the full command as a string
    // Windows CMD requires quotes around device names with spaces
    let videoInput;
    if (cameraName.includes(' ')) {
      // For Windows CMD: video="Device Name" - quotes are needed
      // Escape any existing quotes in the device name by doubling them
      const escapedName = cameraName.replace(/"/g, '""');
      videoInput = `video="${escapedName}"`;
    } else {
      videoInput = `video=${cameraName}`;
    }
    
    console.log(`Device name: "${cameraName}"`);
    console.log(`FFmpeg input: ${videoInput}`);
    
    // Construct full command as a single string
    // Quote the ffmpeg path and the video input properly for Windows CMD
    const fullCommand = `"${ffmpeg}" -f dshow -rtbufsize 200M -framerate 30 -i ${videoInput} -c:v mjpeg -q:v 5 -s 1280x720 -r 30 -f mjpeg pipe:1`;
    console.log(`FFmpeg command: ${fullCommand}`);
    
    captureProcess = spawn(fullCommand, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true  // Use shell to execute the full command string
    });

    let frameCount = 0;
    let buffer = Buffer.alloc(0);
    
    // MJPEG stream parser
    captureProcess.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      
      let startIndex = 0;
      
      while (startIndex < buffer.length) {
        const jpegStart = buffer.indexOf(Buffer.from([0xFF, 0xD8]), startIndex);
        if (jpegStart === -1) {
          buffer = buffer.slice(startIndex);
          break;
        }
        
        const jpegEnd = buffer.indexOf(Buffer.from([0xFF, 0xD9]), jpegStart + 2);
        if (jpegEnd === -1) {
          buffer = buffer.slice(jpegStart);
          break;
        }
        
        const frameEnd = jpegEnd + 2;
        const frame = buffer.slice(jpegStart, frameEnd);
        currentFrameBuffer = frame;
        frameCount++;
        startIndex = frameEnd;
      }
      
      if (startIndex < buffer.length) {
        buffer = buffer.slice(startIndex);
      } else {
        buffer = Buffer.alloc(0);
      }
    });

    captureProcess.stderr.on('data', (data) => {
      const msg = data.toString('utf-8').trim();
      if (msg && !msg.includes('frame=') && !msg.includes('fps=')) {
        if (msg.includes('error') || msg.includes('Error') || msg.includes('Failed')) {
          console.error(`[FFmpeg] ${msg}`);
        }
      }
    });

    captureProcess.on('error', (err) => {
      console.error('Capture process error:', err);
      captureProcess = null;
    });

    captureProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Capture process exited with code ${code}`);
      }
      captureProcess = null;
    });

    console.log('✓ OBS Virtual Camera capture started');
    return true;
  } catch (err) {
    console.error('Failed to start OBS camera capture:', err);
    return false;
  }
}

// Fallback: desktop capture
function startDesktopCapture(ffmpeg) {
  try {
    console.log('Using desktop capture (gdigrab)');
    
    const args = [
      '-f', 'gdigrab',
      '-framerate', '30',
      '-i', 'desktop',
      '-c:v', 'mjpeg',
      '-q:v', '5',
      '-s', '1280x720',
      '-r', '30',
      '-f', 'mjpeg',
      'pipe:1'
    ];
    
    captureProcess = spawn(ffmpeg, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true
    });

    let frameCount = 0;
    let buffer = Buffer.alloc(0);
    
    captureProcess.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      
      let startIndex = 0;
      
      while (startIndex < buffer.length) {
        const jpegStart = buffer.indexOf(Buffer.from([0xFF, 0xD8]), startIndex);
        if (jpegStart === -1) {
          buffer = buffer.slice(startIndex);
          break;
        }
        
        const jpegEnd = buffer.indexOf(Buffer.from([0xFF, 0xD9]), jpegStart + 2);
        if (jpegEnd === -1) {
          buffer = buffer.slice(jpegStart);
          break;
        }
        
        const frameEnd = jpegEnd + 2;
        const frame = buffer.slice(jpegStart, frameEnd);
        currentFrameBuffer = frame;
        frameCount++;
        startIndex = frameEnd;
      }
      
      if (startIndex < buffer.length) {
        buffer = buffer.slice(startIndex);
      } else {
        buffer = Buffer.alloc(0);
      }
    });

    captureProcess.stderr.on('data', (data) => {
      // Suppress verbose FFmpeg output
    });

    captureProcess.on('error', (err) => {
      console.error('Capture process error:', err);
      captureProcess = null;
    });

    captureProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error(`Capture process exited with code ${code}`);
      }
      captureProcess = null;
    });

    console.log('✓ Desktop capture started');
    return true;
  } catch (err) {
    console.error('Failed to start desktop capture:', err);
    return false;
  }
}

// Create MJPEG HTTP server
const server = http.createServer((req, res) => {
  if (req.url === '/mjpeg') {
    // MJPEG stream endpoint
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Connection': 'close',
      'Cache-Control': 'no-cache'
    });

    let frameCount = 0;

    const sendFrame = () => {
      if (currentFrameBuffer && currentFrameBuffer.length > 0) {
        frameCount++;
        res.write('--frame\r\n');
        res.write('Content-Type: image/jpeg\r\n');
        res.write(`Content-Length: ${currentFrameBuffer.length}\r\n\r\n`);
        res.write(currentFrameBuffer);
        res.write('\r\n');
        
        if (frameCount % 30 === 0) {
          console.log(`Streaming frame ${frameCount}, buffer size: ${currentFrameBuffer.length} bytes`);
        }
      }
    };

    sendFrame();

    const interval = setInterval(() => {
      if (!res.writableEnded) {
        sendFrame();
      } else {
        clearInterval(interval);
        console.log(`Stream ended after ${frameCount} frames`);
      }
    }, 33);

    res.on('end', () => clearInterval(interval));
    res.on('error', () => clearInterval(interval));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head><title>Spout MJPEG Stream</title></head>
      <body>
        <h1>Spout MJPEG Stream</h1>
        <img src="/mjpeg" style="max-width: 100%; height: auto;" />
        <p>Mode: ${CAPTURE_MODE === 'stream' ? `HTTP Stream (${STREAM_URL})` : `${SPOUT_SENDER_NAME} (via OBS Virtual Camera)`}</p>
      </body>
      </html>
    `);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(SPOUT_PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log(`\n====================================`);
  console.log(`Spout MJPEG bridge running!`);
  console.log(`====================================`);
  if (CAPTURE_MODE === 'stream') {
    console.log(`Capture mode: HTTP Stream (manual)`);
    console.log(`Stream URL: ${STREAM_URL}`);
  } else if (CAPTURE_MODE === 'obs') {
    console.log(`Capture mode: OBS Virtual Camera (manual)`);
  } else {
    console.log(`Capture mode: Auto (trying: Spout → Stream → OBS → Desktop)`);
    console.log(`Target sender: ${SPOUT_SENDER_NAME}`);
    console.log(`Stream URL: ${STREAM_URL}`);
  }
  console.log(`Local access:   http://127.0.0.1:${SPOUT_PORT}/mjpeg`);
  console.log(`Network access: http://${localIP}:${SPOUT_PORT}/mjpeg`);
  console.log(`====================================\n`);
});

// Start capturing
const captureResult = startSpoutCapture();
if (captureResult && typeof captureResult.then === 'function') {
  // Handle Promise-based capture (auto mode with fallbacks)
  captureResult.then(success => {
    if (!success) {
      console.error('Failed to start capture with any method.');
      process.exit(1);
    }
  }).catch(err => {
    console.error('Error during capture startup:', err);
    process.exit(1);
  });
} else if (!captureResult) {
  // Handle synchronous boolean return (manual mode)
  console.error('Failed to start capture.');
  process.exit(1);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  if (captureInterval) {
    clearInterval(captureInterval);
  }
  if (captureProcess) {
    captureProcess.kill();
  }
  server.close(() => process.exit(0));
});
