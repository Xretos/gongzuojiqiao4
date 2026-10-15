/**
 * Quiet.js Loader and Mobile Browser Hardening Layer
 * Implements defenses against:
 * 1. Android Chrome/Edge strict getUserMedia user gesture policies
 * 2. Emscripten locateFile .mem 404 / abort issues
 * 3. Missing intArrayFromString and ccall in compiled Emscripten exports
 */

export interface QuietEngineConfig {
  profilesUrl: string;
  memUrl: string;
  emscriptenJsUrl: string;
  quietJsUrl: string;
}

// Default URLs pointing to local static assets in /quiet/ with fallback to jsdelivr CDN
export const DEFAULT_QUIET_CONFIG: QuietEngineConfig = {
  profilesUrl: '/quiet/quiet-profiles.json',
  memUrl: '/quiet/quiet-emscripten.js.mem',
  emscriptenJsUrl: '/quiet/quiet-emscripten.js',
  quietJsUrl: '/quiet/quiet.js',
};

export const CDN_QUIET_CONFIG: QuietEngineConfig = {
  profilesUrl: 'https://cdn.jsdelivr.net/gh/quiet/quiet-js@master/quiet-profiles.json',
  memUrl: 'https://cdn.jsdelivr.net/gh/quiet/quiet-js@master/quiet-emscripten.js.mem',
  emscriptenJsUrl: 'https://cdn.jsdelivr.net/gh/quiet/quiet-js@master/quiet-emscripten.js',
  quietJsUrl: 'https://cdn.jsdelivr.net/gh/quiet/quiet-js@master/quiet.js',
};

declare global {
  interface Window {
    Module: any;
    Quiet: any;
    __quietSonicStream?: MediaStream;
    __quietSonicAudioCtx?: AudioContext;
  }
}

/**
 * Polyfill for Emscripten intArrayFromString with UTF-8 encoding support.
 */
export function injectIntArrayFromString(targetModule: any) {
  targetModule.intArrayFromString = function (
    stringy: string,
    dontAddNull?: boolean,
    length?: number
  ): number[] {
    const utf8: number[] = [];
    for (let i = 0; i < stringy.length; i++) {
      let charcode = stringy.charCodeAt(i);
      if (charcode < 0x80) {
        utf8.push(charcode);
      } else if (charcode < 0x800) {
        utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
      } else if (charcode < 0xd800 || charcode >= 0xe000) {
        utf8.push(
          0xe0 | (charcode >> 12),
          0x80 | ((charcode >> 6) & 0x3f),
          0x80 | (charcode & 0x3f)
        );
      } else {
        i++;
        charcode =
          0x10000 + (((charcode & 0x3ff) << 10) | (stringy.charCodeAt(i) & 0x3ff));
        utf8.push(
          0xf0 | (charcode >> 18),
          0x80 | ((charcode >> 12) & 0x3f),
          0x80 | ((charcode >> 6) & 0x3f),
          0x80 | (charcode & 0x3f)
        );
      }
    }
    if (!dontAddNull) {
      utf8.push(0);
    }
    if (length && length > 0) {
      while (utf8.length < length) utf8.push(0);
      if (utf8.length > length) utf8.length = length;
    }
    return utf8;
  };
}

/**
 * Polyfill for Emscripten ccall to invoke exported C functions.
 */
export function injectCCall(targetModule: any) {
  targetModule.ccall = function (
    ident: string,
    returnType: string | null,
    argTypes?: string[],
    args?: any[]
  ) {
    const toRet: Record<string, (val: any) => any> = {
      string: (value: any) => {
        if (!value) return '';
        const ret: string[] = [];
        let i = 0;
        while (targetModule.HEAPU8 && targetModule.HEAPU8[value + i]) {
          ret.push(String.fromCharCode(targetModule.HEAPU8[value + i]));
          i++;
        }
        return ret.join('');
      },
      boolean: (value: any) => Boolean(value),
    };

    const func = targetModule['_' + ident];
    if (typeof func !== 'function') {
      throw new Error(`Emscripten exported function _${ident} not found on Module.`);
    }

    const cArgs: any[] = [];
    const allocated: number[] = [];

    if (args && argTypes) {
      for (let i = 0; i < args.length; i++) {
        const type = argTypes[i];
        const val = args[i];
        if (type === 'string') {
          const arr = targetModule.intArrayFromString(val);
          const ptr = targetModule._malloc(arr.length);
          targetModule.HEAPU8.set(arr, ptr);
          cArgs.push(ptr);
          allocated.push(ptr);
        } else if (type === 'array') {
          const u8 = val instanceof Uint8Array ? val : new Uint8Array(val.buffer || val);
          const ptr = targetModule._malloc(u8.length);
          targetModule.HEAPU8.set(u8, ptr);
          cArgs.push(ptr);
          allocated.push(ptr);
        } else {
          cArgs.push(val);
        }
      }
    }

    const ret = func.apply(null, cArgs);

    for (const ptr of allocated) {
      if (typeof targetModule._free === 'function') {
        targetModule._free(ptr);
      }
    }

    if (returnType && toRet[returnType]) {
      return toRet[returnType](ret);
    }
    return ret;
  };
}

/**
 * Loads a script dynamically and returns a promise.
 */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already injected
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = (e) => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
  });
}

/**
 * Initializes and hardens the Quiet.js and Emscripten runtime.
 * Guarantees that:
 * 1. window.Module.locateFile points strictly to memUrl.
 * 2. window.Module.intArrayFromString and ccall are injected.
 * 3. quiet.js and quiet-emscripten.js are loaded in correct order.
 */
export async function initializeQuietEngine(
  config: QuietEngineConfig = DEFAULT_QUIET_CONFIG,
  onLog?: (msg: string) => void
): Promise<void> {
  const log = onLog || console.log;
  log('Initializing WebAssembly/Emscripten Module environment...');

  // 1. Prepare window.Module before loading any scripts
  window.Module = window.Module || {};

  // Defense 2: Override locateFile for .mem lookup
  const memAbsoluteUrl = new URL(config.memUrl, window.location.href).href;
  const memDir = memAbsoluteUrl.substring(0, memAbsoluteUrl.lastIndexOf('/') + 1);
  (window as any).memoryInitializerPrefixURL = memDir;
  (window as any).memoryInitializerPrefix = memDir;

  const robustLocateFile = function (path: string, prefix: string) {
    if (path.endsWith('.mem') || path.includes('quiet-emscripten.js.mem')) {
      log(`[Module.locateFile] Intercepted memory request for "${path}" -> ${memAbsoluteUrl}`);
      return memAbsoluteUrl;
    }
    return (prefix || '') + path;
  };

  window.Module.locateFile = robustLocateFile;

  // Defense 3: Pre-inject intArrayFromString and ccall
  injectIntArrayFromString(window.Module);
  injectCCall(window.Module);

  // 2. Load quiet.js first
  log('Loading quiet.js...');
  try {
    await loadScript(config.quietJsUrl);
  } catch (err) {
    log('Failed loading local quiet.js, attempting CDN fallback...');
    await loadScript(CDN_QUIET_CONFIG.quietJsUrl);
  }

  // Ensure window globals and locateFile are preserved after quiet.js executes
  (window as any).memoryInitializerPrefixURL = memDir;
  (window as any).memoryInitializerPrefix = memDir;
  window.Module.locateFile = robustLocateFile;
  injectIntArrayFromString(window.Module);
  injectCCall(window.Module);

  // 3. Load quiet-emscripten.js
  log('Loading quiet-emscripten.js...');
  try {
    await loadScript(config.emscriptenJsUrl);
  } catch (err) {
    log('Failed loading local quiet-emscripten.js, attempting CDN fallback...');
    await loadScript(CDN_QUIET_CONFIG.emscriptenJsUrl);
  }

  // Re-verify injections on window.Module
  window.Module.locateFile = robustLocateFile;
  injectIntArrayFromString(window.Module);
  injectCCall(window.Module);

  // 4. Initialize Quiet library
  const profilesAbsoluteUrl = new URL(config.profilesUrl, window.location.href).href;
  const profilesDir = profilesAbsoluteUrl.substring(0, profilesAbsoluteUrl.lastIndexOf('/') + 1);

  log(`Calling Quiet.init with profiles: ${profilesDir}, mem: ${memDir}`);

  return new Promise<void>((resolve, reject) => {
    if (!window.Quiet) {
      reject(new Error('window.Quiet is undefined after script loading'));
      return;
    }

    window.Quiet.init({
      profilesPrefix: profilesDir,
      memoryInitializerPrefix: memDir,
      onReady: () => {
        log('Quiet.js engine successfully initialized and ready!');
        resolve();
      },
      onError: (reason: string) => {
        const errorMsg = `Quiet.init failed: ${reason}`;
        log(`[ERROR] ${errorMsg}`);
        reject(new Error(errorMsg));
      },
    });
  });
}

/**
 * Defense 1: Synchronous Microphone Acquisition on User Gesture.
 * Requests microphone permission synchronously during click event,
 * binds it to window.__quietSonicStream, and shims navigator.getUserMedia
 * so Quiet.receiver receives this active stream without being blocked.
 */
export async function acquireMicrophoneStream(onLog?: (msg: string) => void): Promise<MediaStream> {
  const log = onLog || console.log;
  log('Requesting microphone access via navigator.mediaDevices.getUserMedia...');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('navigator.mediaDevices.getUserMedia is not supported by this browser.');
  }

  // High fidelity acoustic constraints (disable noise suppression, echo cancellation, AGC)
  const constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  };

  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  log(`Microphone access granted! Active tracks: ${stream.getAudioTracks().length}`);

  window.__quietSonicStream = stream;

  // Intercept navigator.getUserMedia and webkitGetUserMedia
  const shimGum = function (
    constraintsArg: any,
    successCallback: (stream: MediaStream) => void,
    errorCallback: (err: any) => void
  ) {
    if (window.__quietSonicStream && window.__quietSonicStream.active) {
      log('Handing over pre-acquired MediaStream to Quiet.js audio input pipeline.');
      successCallback(window.__quietSonicStream);
    } else {
      navigator.mediaDevices
        .getUserMedia(constraintsArg)
        .then(successCallback)
        .catch(errorCallback);
    }
  };

  (navigator as any).getUserMedia = shimGum;
  (navigator as any).webkitGetUserMedia = shimGum;
  (navigator as any).mozGetUserMedia = shimGum;

  return stream;
}
