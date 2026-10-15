import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Volume2,
  Mic,
  Activity,
  AlertTriangle,
  Download,
  CheckCircle2,
  RefreshCw,
  Copy,
  Terminal,
  Radio,
  FileText,
  Sliders,
  ShieldCheck,
  Zap,
  Info,
  Bug,
  HelpCircle,
  ExternalLink,
} from 'lucide-react';
import {
  calculateCRC32,
  buildHeaderPacket,
  buildDataChunkPacket,
  packFileToAcousticPackets,
  AcousticReceiverSession,
  ReceiverStats,
  PROTOCOL_CONSTANTS,
} from './utils/protocol';
import {
  initializeQuietEngine,
  acquireMicrophoneStream,
  DEFAULT_QUIET_CONFIG,
} from './utils/quietLoader';

interface LogItem {
  id: string;
  time: string;
  type: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'receiver' | 'transmitter' | 'standalone' | 'protocol'>('receiver');

  // Engine & Device State
  const [isEngineReady, setIsEngineReady] = useState<boolean>(false);
  const [isEngineLoading, setIsEngineLoading] = useState<boolean>(false);
  const [isMicActive, setIsMicActive] = useState<boolean>(false);
  const [isReceiverActive, setIsReceiverActive] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string>('等待启动');

  // Stats & Progress
  const [stats, setStats] = useState<ReceiverStats>({
    status: 'idle',
    filename: null,
    fileSize: 0,
    totalChunks: 0,
    receivedChunksCount: 0,
    crcErrorCount: 0,
    totalPacketsReceived: 0,
    currentKbps: 0,
    averageKbps: 0,
    progressPercent: 0,
    isCrcVerified: null,
    receivedBytes: 0,
  });

  const [chunkMap, setChunkMap] = useState<boolean[]>([]);
  const [completedFile, setCompletedFile] = useState<{
    data: Uint8Array;
    filename: string;
    isCrcValid: boolean;
    fileSize: number;
    fileCrc: number;
  } | null>(null);

  // Audio visualizer state
  const [micVolume, setMicVolume] = useState<number>(0);

  // Logs
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [logFilter, setLogFilter] = useState<'all' | 'error' | 'packet'>('all');
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [copiedLogFeedback, setCopiedLogFeedback] = useState<boolean>(false);
  const [copiedHtmlFeedback, setCopiedHtmlFeedback] = useState<boolean>(false);

  // Transmitter Simulator State
  const [txText, setTxText] = useState<string>('QuietSonic 64k Acoustic Transfer Test\nHigh speed sound communication protocol.');
  const [isTransmitting, setIsTransmitting] = useState<boolean>(false);
  const [txProgress, setTxProgress] = useState<number>(0);

  // References
  const sessionRef = useRef<AcousticReceiverSession>(new AcousticReceiverSession());
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const spectrumCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const quietReceiverRef = useRef<any>(null);
  const quietTransmitterRef = useRef<any>(null);
  const consoleBottomRef = useRef<HTMLDivElement | null>(null);

  const addLog = useCallback((type: LogItem['type'], text: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev.slice(-300), { id: Math.random().toString(36).substring(2, 9), time, type, text }]);
  }, []);

  // Hook global window error catcher
  useEffect(() => {
    (window as any).__onQuietSonicError = (errInfo: any) => {
      setFatalError(`${errInfo.msg} (File: ${errInfo.file}:${errInfo.line})`);
      addLog('error', `[JS运行时捕获] ${errInfo.msg} at ${errInfo.file}:${errInfo.line}`);
    };

    // Load existing errors if any occurred before React mounted
    if ((window as any).__quietSonicGlobalErrors && (window as any).__quietSonicGlobalErrors.length > 0) {
      (window as any).__quietSonicGlobalErrors.forEach((e: any) => {
        addLog('error', `[预加载错误] ${e.msg} (${e.file}:${e.line})`);
      });
    }

    addLog('info', 'QuietSonic 接收端系统初始化完成。请按防御机制要求：先预载 WASM 引擎，再启动麦克风。');

    // Bind session events
    const session = sessionRef.current;
    session.onStatsUpdate = (newStats) => {
      setStats(newStats);
      setChunkMap(session.getChunkMap());
    };

    session.onHeaderReceived = (header) => {
      addLog('success', `[握手成功] 收到文件头: "${header.filename}" (大小: ${header.fileSize} 字节, 分块: ${header.totalChunks}, CRC32: 0x${header.fileCrc.toString(16).toUpperCase()})`);
      setStatusMessage(`正在接收: ${header.filename}`);
    };

    session.onChunkReceived = (chunk, s) => {
      addLog('info', `[分块接收] 块 #${chunk.seq + 1}/${s.totalChunks} (1024 字节, CRC32: 0x${chunk.crc32.toString(16).toUpperCase()})`);
    };

    session.onCrcError = (seq, computed, expected) => {
      addLog('error', `[CRC32错帧] 块 #${seq !== null ? seq : '?'} 校验失败: 计算值 0x${computed.toString(16).toUpperCase()} != 预期值 0x${expected.toString(16).toUpperCase()}`);
    };

    session.onError = (msg) => {
      addLog('warn', `[协议异常] ${msg}`);
    };

    session.onFileCompleted = (fileData, filename, isCrcValid) => {
      if (isCrcValid) {
        addLog('success', `[全局校验通过] 文件 "${filename}" 拼接成功并校验无误，立即触发自动下载！`);
        setStatusMessage('传输完成已自动下载');
        const header = (session as any).header;
        setCompletedFile({
          data: fileData,
          filename,
          isCrcValid: true,
          fileSize: fileData.length,
          fileCrc: header ? header.fileCrc : calculateCRC32(fileData),
        });
        // Auto trigger download
        triggerBlobDownload(fileData, filename);
      } else {
        addLog('error', `[全局CRC32失败] 文件 "${filename}" 拼接后与 Header CRC 不一致！可能存在丢包或篡改。`);
        setStatusMessage('全局校验失败');
      }
    };

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [addLog]);

  // Auto-scroll logs
  useEffect(() => {
    if (consoleBottomRef.current) {
      consoleBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // Audio spectrum visualizer
  const startSpectrumVisualizer = useCallback((stream: MediaStream) => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const render = () => {
        animFrameRef.current = requestAnimationFrame(render);
        analyser.getByteFrequencyData(dataArray);

        // Compute volume
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const avg = sum / bufferLength;
        setMicVolume(Math.min(100, Math.round((avg / 128) * 100)));

        // Render Canvas
        const canvas = spectrumCanvasRef.current;
        if (!canvas) return;
        const cCtx = canvas.getContext('2d');
        if (!cCtx) return;

        cCtx.fillStyle = '#0a0e17';
        cCtx.fillRect(0, 0, canvas.width, canvas.height);

        const barWidth = (canvas.width / bufferLength) * 1.6;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const val = dataArray[i];
          const barHeight = (val / 255) * canvas.height;

          // Highlight cable-64k center frequency (around 10.2kHz)
          // 10.2kHz out of 22.05kHz Nyquist is index ~ 59
          const isCarrierBand = i >= 55 && i <= 65;

          if (isCarrierBand) {
            cCtx.fillStyle = '#06b6d4'; // Cyan for carrier
            cCtx.shadowColor = '#06b6d4';
            cCtx.shadowBlur = 8;
          } else {
            cCtx.fillStyle = '#334155';
            cCtx.shadowBlur = 0;
          }

          cCtx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
          x += barWidth;
        }

        // Draw frequency guides
        cCtx.shadowBlur = 0;
        cCtx.fillStyle = '#94a3b8';
        cCtx.font = '9px monospace';
        cCtx.fillText('0 Hz', 4, 12);
        cCtx.fillText('10.2 kHz (cable-64k 载波)', canvas.width * 0.42, 12);
        cCtx.fillText('22 kHz', canvas.width - 40, 12);
      };

      render();
    } catch (e: any) {
      addLog('warn', `频谱分析器启动异常: ${e.message}`);
    }
  }, [addLog]);

  // Step 1: Preload Engine
  const handlePreloadEngine = async () => {
    if (isEngineReady || isEngineLoading) return;
    setIsEngineLoading(true);
    setStatusMessage('正在预载 WASM 引擎...');
    addLog('info', '【防御机制 2 & 3 执行】加载 Quiet.js 与 WebAssembly 模块，配置绝对 locateFile 与 intArrayFromString...');

    try {
      await initializeQuietEngine(undefined, (msg) => addLog('info', msg));
      setIsEngineReady(true);
      setStatusMessage('引擎就绪，请开启麦克风');
      addLog('success', 'WASM 引擎预载成功！现在请点击“开启麦克风监听”按钮。');
    } catch (err: any) {
      addLog('error', `WASM 引擎预载失败: ${err.message}`);
      setStatusMessage('引擎加载失败');
    } finally {
      setIsEngineLoading(false);
    }
  };

  // Step 2: Acquire Microphone and Start Receiver
  const handleStartReceiver = async () => {
    if (isReceiverActive) return;

    // Defense 1: Strictly synchronous invocation on user click gesture
    addLog('info', '【防御机制 1 执行】用户手势瞬间同步调用 navigator.mediaDevices.getUserMedia...');
    setStatusMessage('正在请求麦克风...');

    try {
      // 1. Synchronously get media stream
      const stream = await acquireMicrophoneStream((msg) => addLog('info', msg));
      setIsMicActive(true);
      addLog('success', `麦克风获取成功！已启动音频分析器`);

      // Start spectrum visualizer
      startSpectrumVisualizer(stream);

      // If engine not yet preloaded, preload now
      if (!isEngineReady) {
        addLog('info', '自动初始化 Quiet.js 核心...');
        await initializeQuietEngine(undefined, (msg) => addLog('info', msg));
        setIsEngineReady(true);
      }

      // 2. Start Quiet Receiver
      addLog('info', `调用 window.Quiet.receiver 创建 cable-64k 解调通道...`);
      if (!window.Quiet) {
        throw new Error('window.Quiet 未定义');
      }

      const receiver = window.Quiet.receiver({
        profile: 'cable-64k',
        onReceive: (payload: ArrayBuffer) => {
          sessionRef.current.processRawFrame(payload);
        },
        onCreate: () => {
          setIsReceiverActive(true);
          setStatusMessage('正在监听声波数据 (cable-64k)...');
          addLog('success', 'Quiet 声波解调器已连接麦克风流，正在监听 10.2kHz QAM1024 信号！');
        },
        onCreateFail: (reason: string) => {
          setIsReceiverActive(false);
          addLog('error', `创建 Quiet 接收器失败: ${reason}`);
          setStatusMessage(`解调器创建失败: ${reason}`);
        },
        onReceiveFail: (totalFails: number) => {
          addLog('warn', `Quiet 底层检测到错帧 (累积错帧数: ${totalFails})`);
          setStats((prev) => ({ ...prev, crcErrorCount: prev.crcErrorCount + 1 }));
        },
        onReceiverStatsUpdate: (statsArr: any[]) => {
          if (statsArr && statsArr.length > 0) {
            const latest = statsArr[statsArr.length - 1];
            // Signal detected
            if (latest.receivedSignalStrengthIndicator !== undefined) {
              // Could track RSSI
            }
          }
        },
      });

      quietReceiverRef.current = receiver;
    } catch (err: any) {
      addLog('error', `启动监听失败: ${err.name} - ${err.message}`);
      setStatusMessage(`启动受阻: ${err.message}`);
    }
  };

  const handleStopReceiver = () => {
    if (quietReceiverRef.current) {
      try {
        quietReceiverRef.current.destroy();
      } catch (e) {}
      quietReceiverRef.current = null;
    }
    if (window.__quietSonicStream) {
      window.__quietSonicStream.getTracks().forEach((t) => t.stop());
      window.__quietSonicStream = undefined;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    setIsReceiverActive(false);
    setIsMicActive(false);
    setStatusMessage('已停止监听');
    addLog('info', '接收端麦克风与解调器已安全关闭。');
  };

  const handleResetSession = () => {
    sessionRef.current.reset();
    setCompletedFile(null);
    setStatusMessage(isReceiverActive ? '正在监听声波数据...' : '就绪');
    addLog('info', '接收会话已重置，清除全部已接收分块。');
  };

  // Trigger file download
  const triggerBlobDownload = (bytes: Uint8Array, filename: string) => {
    try {
      const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      addLog('success', `[自动下载] 浏览器已触发保存文件: "${filename}"`);
    } catch (e: any) {
      addLog('error', `触发下载失败: ${e.message}`);
    }
  };

  // Simulation Lab: Direct Packet Injection
  const handleSimulateNormalTransfer = () => {
    addLog('info', '【模拟测试】生成 2.8KB 测试文件并模拟声波数据帧注入...');
    const content = `QuietSonic High Speed Acoustic Receiver Demo File.\n` +
      `Timestamp: ${new Date().toISOString()}\n` +
      `Protocol: Big-Endian, 78B Header (0xDEADBEEF), 1030B Chunks, IEEE 802.3 CRC32.\n` +
      `Line: =========================================================\n` +
      `Payload verification: The quick brown fox jumps over the lazy dog.\n`.repeat(40);
    const fileBytes = new TextEncoder().encode(content);
    const filename = `test_doc_${Date.now().toString().slice(-4)}.txt`;

    const { header, chunks, fileCrc, totalChunks } = packFileToAcousticPackets(filename, fileBytes);
    addLog('info', `准备注入: 文件头 (78字节) + ${chunks.length} 个数据块 (每个1030字节)`);

    // 1. Inject Header
    sessionRef.current.processRawFrame(header);

    // 2. Inject Chunks sequentially with realistic time intervals
    chunks.forEach((chunk, idx) => {
      setTimeout(() => {
        sessionRef.current.processRawFrame(chunk);
      }, (idx + 1) * 250);
    });
  };

  // Simulation Lab: Corrupted CRC Injection
  const handleSimulateCorruptedPacket = () => {
    addLog('warn', '【模拟测试】注入故意篡改 CRC32 的损坏数据包，检验容错与错帧统计...');
    const fakeChunk = buildDataChunkPacket(0, new TextEncoder().encode('Test corrupted chunk'));
    // Invert the CRC byte
    fakeChunk[1027] ^= 0xAA;
    sessionRef.current.processRawFrame(fakeChunk);
  };

  // Simulation Lab: Actual Acoustic Transmitter (emit sound via Quiet.transmitter)
  const handleTransmitAcoustically = async () => {
    if (isTransmitting) return;

    if (!isEngineReady) {
      addLog('info', '声学发射前自动加载 Quiet WASM 引擎...');
      await handlePreloadEngine();
    }

    if (!window.Quiet || !window.Quiet.transmitter) {
      addLog('error', 'Quiet.transmitter 不可用');
      return;
    }

    setIsTransmitting(true);
    setTxProgress(0);
    addLog('info', '【真实声波发射】开始通过扬声器发射 cable-64k 调制声波...');

    try {
      const fileBytes = new TextEncoder().encode(txText);
      const filename = 'transmitted_payload.txt';
      const { header, chunks } = packFileToAcousticPackets(filename, fileBytes);

      const allFrames = [header, ...chunks];

      const tx = window.Quiet.transmitter({
        profile: 'cable-64k',
        onFinish: () => {
          setIsTransmitting(false);
          setTxProgress(100);
          addLog('success', '声学发射全部完成！');
        },
      });
      quietTransmitterRef.current = tx;

      // Transmit all frames
      allFrames.forEach((frame, idx) => {
        setTimeout(() => {
          if (tx && tx.transmit) {
            tx.transmit(frame.buffer);
            setTxProgress(Math.round(((idx + 1) / allFrames.length) * 100));
            addLog('info', `[声学外放] 发射帧 #${idx + 1}/${allFrames.length} (${frame.byteLength} 字节)`);
          }
        }, idx * 600);
      });
    } catch (e: any) {
      addLog('error', `发射失败: ${e.message}`);
      setIsTransmitting(false);
    }
  };

  // Copy Logs
  const handleCopyLogs = () => {
    const text = logs.map((l) => `[${l.time}] [${l.type.toUpperCase()}] ${l.text}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopiedLogFeedback(true);
    setTimeout(() => setCopiedLogFeedback(false), 2000);
  };

  // Standalone HTML code text
  const [standaloneHtmlCode, setStandaloneHtmlCode] = useState<string>('');
  useEffect(() => {
    fetch('/standalone-receiver.html')
      .then((res) => res.text())
      .then((code) => setStandaloneHtmlCode(code))
      .catch(() => {});
  }, []);

  const handleCopyStandaloneHtml = () => {
    navigator.clipboard.writeText(standaloneHtmlCode);
    setCopiedHtmlFeedback(true);
    setTimeout(() => setCopiedHtmlFeedback(false), 2000);
  };

  const handleDownloadStandaloneHtml = () => {
    const blob = new Blob([standaloneHtmlCode], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'index.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  // Filtered logs
  const filteredLogs = logs.filter((l) => {
    if (logFilter === 'error') return l.type === 'error' || l.type === 'warn';
    if (logFilter === 'packet') return l.text.includes('分块') || l.text.includes('握手') || l.text.includes('帧');
    return true;
  });

  return (
    <div className="min-h-screen bg-[#0a0d14] text-slate-100 flex flex-col font-sans pb-12">
      {/* Top Header */}
      <header className="sticky top-0 z-30 bg-[#0f1422]/95 backdrop-blur-md border-b border-slate-800 px-4 py-3 shadow-lg">
        <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 to-emerald-400 flex items-center justify-center text-black font-black text-lg shadow-[0_0_16px_rgba(6,182,212,0.4)]">
              Q
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-base sm:text-lg tracking-wide text-white">QuietSonic</h1>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-cyan-950/80 text-cyan-400 border border-cyan-700/50">
                  cable-64k
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Android 手机浏览器高速声波数据接收端 (10.2kHz / QAM1024)
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800 text-xs font-medium">
            <button
              onClick={() => setActiveTab('receiver')}
              className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all ${
                activeTab === 'receiver' ? 'bg-cyan-500 text-black font-semibold shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>接收端</span>
            </button>
            <button
              onClick={() => setActiveTab('transmitter')}
              className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all ${
                activeTab === 'transmitter' ? 'bg-cyan-500 text-black font-semibold shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              <span>发射/测试</span>
            </button>
            <button
              onClick={() => setActiveTab('standalone')}
              className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all ${
                activeTab === 'standalone' ? 'bg-cyan-500 text-black font-semibold shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              <span>单文件 HTML</span>
            </button>
            <button
              onClick={() => setActiveTab('protocol')}
              className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all ${
                activeTab === 'protocol' ? 'bg-cyan-500 text-black font-semibold shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>协议规范</span>
            </button>
          </nav>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-6xl mx-auto w-full px-3 sm:px-4 py-4 flex flex-col gap-4">
        {/* On-screen Fatal Error Banner (Crucial for Mobile Android) */}
        {fatalError && (
          <div className="bg-red-950/90 border-2 border-red-500 rounded-xl p-3 text-red-200 text-xs sm:text-sm flex items-start gap-3 shadow-[0_0_20px_rgba(239,68,68,0.3)] animate-pulse">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-bold text-red-100 mb-0.5">运行时异常捕获 (Visible On-Screen Exception)</div>
              <p className="font-mono text-xs break-all">{fatalError}</p>
            </div>
            <button
              onClick={() => setFatalError(null)}
              className="text-xs bg-red-900 hover:bg-red-800 text-red-200 px-2 py-1 rounded"
            >
              忽略
            </button>
          </div>
        )}

        {/* TAB 1: RECEIVER DASHBOARD */}
        {activeTab === 'receiver' && (
          <div className="flex flex-col gap-4">
            {/* Control & Hardening Banner */}
            <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 shadow-md flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    Android 移动端防御机制控制台
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-400">当前会话:</span>
                  <span className="font-medium text-cyan-300 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-800/40">
                    {statusMessage}
                  </span>
                </div>
              </div>

              {/* Status Indicator Badges */}
              <div className="grid grid-cols-3 gap-2 bg-[#0a0e17] p-2.5 rounded-xl border border-slate-800/80">
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${isEngineReady ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' : 'bg-slate-600'}`} />
                  <span className="text-xs text-slate-300">WASM 引擎</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${isMicActive ? 'bg-emerald-400 shadow-[0_0_8px_#34d399] animate-pulse' : 'bg-slate-600'}`} />
                  <span className="text-xs text-slate-300">麦克风流</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className={`w-2.5 h-2.5 rounded-full ${isReceiverActive ? 'bg-cyan-400 shadow-[0_0_8px_#22d3ee] animate-pulse' : 'bg-slate-600'}`} />
                  <span className="text-xs text-slate-300">声波解调器</span>
                </div>
              </div>

              {/* Action Buttons: 2-step separation */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <button
                  onClick={handlePreloadEngine}
                  disabled={isEngineReady || isEngineLoading}
                  className={`py-3 px-4 rounded-xl font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all ${
                    isEngineReady
                      ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/50 cursor-default'
                      : 'bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 active:scale-[0.98]'
                  }`}
                >
                  <Zap className="w-4 h-4 text-cyan-400" />
                  <span>{isEngineReady ? '✓ 步骤1: WASM 引擎已就绪' : isEngineLoading ? '正在加载引擎文件...' : '1. 预载 WASM 引擎'}</span>
                </button>

                <button
                  onClick={isReceiverActive ? handleStopReceiver : handleStartReceiver}
                  className={`py-3 px-4 rounded-xl font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-md active:scale-[0.98] ${
                    isReceiverActive
                      ? 'bg-red-500/20 text-red-300 border border-red-500/50 hover:bg-red-500/30'
                      : 'bg-gradient-to-r from-cyan-500 to-blue-600 text-black font-bold shadow-[0_0_20px_rgba(6,182,212,0.35)] hover:brightness-110'
                  }`}
                >
                  <Mic className="w-4 h-4" />
                  <span>{isReceiverActive ? '停止监听并释放麦克风' : '2. 开启麦克风监听 (同步授权)'}</span>
                </button>
              </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {/* Bitrate */}
              <div className="bg-[#121826] border border-slate-800 rounded-xl p-3.5 flex flex-col items-center justify-center text-center">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">实时接收速率</span>
                <div className="text-2xl sm:text-3xl font-mono font-bold text-cyan-400">
                  {stats.currentKbps.toFixed(1)} <span className="text-xs font-normal text-slate-400">kbps</span>
                </div>
                <span className="text-[10px] text-slate-500 mt-1">平均: {stats.averageKbps} kbps</span>
              </div>

              {/* CRC Errors */}
              <div className="bg-[#121826] border border-slate-800 rounded-xl p-3.5 flex flex-col items-center justify-center text-center">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">CRC 错帧统计</span>
                <div className={`text-2xl sm:text-3xl font-mono font-bold ${stats.crcErrorCount > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {stats.crcErrorCount}
                </div>
                <span className="text-[10px] text-slate-500 mt-1">
                  总帧数: {stats.totalPacketsReceived} | 错误率: {stats.totalPacketsReceived > 0 ? ((stats.crcErrorCount / stats.totalPacketsReceived) * 100).toFixed(1) : 0}%
                </span>
              </div>

              {/* Chunk Progress */}
              <div className="bg-[#121826] border border-slate-800 rounded-xl p-3.5 flex flex-col items-center justify-center text-center">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">数据块接收</span>
                <div className="text-2xl sm:text-3xl font-mono font-bold text-white">
                  {stats.receivedChunksCount} <span className="text-xs font-normal text-slate-400">/ {stats.totalChunks}</span>
                </div>
                <span className="text-[10px] text-slate-500 mt-1">
                  有效载荷: {(stats.receivedBytes / 1024).toFixed(1)} KB
                </span>
              </div>

              {/* Microphone Volume / VU */}
              <div className="bg-[#121826] border border-slate-800 rounded-xl p-3.5 flex flex-col items-center justify-center text-center">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1">麦克风电平 (VU)</span>
                <div className="text-2xl sm:text-3xl font-mono font-bold text-emerald-400">
                  {micVolume}%
                </div>
                <div className="w-full bg-slate-800 h-1.5 rounded-full mt-2 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-emerald-500 via-cyan-400 to-red-500 transition-all duration-75"
                    style={{ width: `${micVolume}%` }}
                  />
                </div>
              </div>
            </div>

            {/* Audio Spectrum & 10.2kHz Carrier Monitor */}
            <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 shadow-md flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-cyan-400" />
                  <span className="font-semibold text-slate-300">实时音频频谱 (10.2kHz 载波检测)</span>
                </div>
                <span className="text-[11px] text-slate-400 font-mono">
                  采样率: {audioCtxRef.current ? `${audioCtxRef.current.sampleRate} Hz` : '待连接'}
                </span>
              </div>
              <canvas
                ref={spectrumCanvasRef}
                width={700}
                height={90}
                className="w-full h-20 rounded-xl bg-[#0a0e17] border border-slate-800/80"
              />
            </div>

            {/* Transfer Progress & Chunk Piece Matrix */}
            <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 shadow-md flex flex-col gap-3">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  <span className="font-semibold text-slate-200">
                    {stats.filename ? `文件传输中: ${stats.filename} (${(stats.fileSize / 1024).toFixed(1)} KB)` : '传输进度 (等待 Header 0xDEADBEEF)'}
                  </span>
                </div>
                <span className="font-mono font-bold text-cyan-400 text-sm">
                  {stats.progressPercent.toFixed(1)}%
                </span>
              </div>

              {/* Progress bar */}
              <div className="w-full h-3 bg-[#0a0e17] rounded-full overflow-hidden border border-slate-800/80 p-0.5">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-150 shadow-[0_0_12px_rgba(6,182,212,0.4)]"
                  style={{ width: `${stats.progressPercent}%` }}
                />
              </div>

              {/* Chunk Matrix (BitTorrent piece map style) */}
              <div className="flex flex-col gap-1.5 mt-1">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span>分块网格 (每块 1024 字节)</span>
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm bg-emerald-400 inline-block" /> 已校验
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded-sm bg-slate-800 inline-block" /> 未收到
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto p-2 bg-[#0a0e17] rounded-xl border border-slate-800/80">
                  {chunkMap.length === 0 ? (
                    <div className="text-xs text-slate-500 py-3 w-full text-center">
                      等待握手数据包... 握手成功后将动态渲染数据块单元。
                    </div>
                  ) : (
                    chunkMap.map((isReceived, i) => (
                      <div
                        key={i}
                        title={`分块 #${i + 1} (${isReceived ? '已接收并校验' : '未到达'})`}
                        className={`w-3.5 h-3.5 rounded-sm text-[8px] flex items-center justify-center font-mono transition-all ${
                          isReceived
                            ? 'bg-emerald-400 text-black font-bold shadow-[0_0_6px_rgba(16,185,129,0.5)]'
                            : 'bg-slate-800 text-slate-500'
                        }`}
                      >
                        {i + 1}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Completed File Banner */}
            {completedFile && (
              <div className="bg-gradient-to-r from-emerald-950/70 to-slate-900 border border-emerald-500/60 rounded-2xl p-4 shadow-[0_0_24px_rgba(16,185,129,0.25)] flex flex-col sm:flex-row items-center justify-between gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                    <CheckCircle2 className="w-7 h-7" />
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-base">{completedFile.filename}</h3>
                    <div className="text-xs text-slate-300 flex flex-wrap gap-x-3 gap-y-1 mt-0.5">
                      <span>大小: {(completedFile.fileSize / 1024).toFixed(2)} KB ({completedFile.fileSize} 字节)</span>
                      <span>全局 CRC32: 0x{completedFile.fileCrc.toString(16).toUpperCase()}</span>
                      <span className="text-emerald-400 font-semibold">✓ 校验一致</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <button
                    onClick={() => triggerBlobDownload(completedFile.data, completedFile.filename)}
                    className="flex-1 sm:flex-initial px-4 py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-xl text-xs sm:text-sm flex items-center justify-center gap-2 shadow-md"
                  >
                    <Download className="w-4 h-4" />
                    <span>重新下载</span>
                  </button>
                  <button
                    onClick={handleResetSession}
                    className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs sm:text-sm"
                  >
                    重置
                  </button>
                </div>
              </div>
            )}

            {/* On-screen Logs Console (Mandatory for Android Phone F12 Debugging) */}
            <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 shadow-md flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    手机端可视控制台与运行日志
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <div className="flex items-center bg-[#0a0e17] rounded-lg p-0.5 border border-slate-800 text-[11px]">
                    <button
                      onClick={() => setLogFilter('all')}
                      className={`px-2 py-0.5 rounded ${logFilter === 'all' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}
                    >
                      全部
                    </button>
                    <button
                      onClick={() => setLogFilter('packet')}
                      className={`px-2 py-0.5 rounded ${logFilter === 'packet' ? 'bg-slate-700 text-white' : 'text-slate-400'}`}
                    >
                      分包
                    </button>
                    <button
                      onClick={() => setLogFilter('error')}
                      className={`px-2 py-0.5 rounded ${logFilter === 'error' ? 'bg-red-900 text-red-200' : 'text-slate-400'}`}
                    >
                      错误
                    </button>
                  </div>
                  <button
                    onClick={handleCopyLogs}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs flex items-center gap-1 border border-slate-700"
                  >
                    <Copy className="w-3 h-3" />
                    <span>{copiedLogFeedback ? '已复制' : '复制日志'}</span>
                  </button>
                  <button
                    onClick={() => setLogs([])}
                    className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs border border-slate-700"
                  >
                    清空
                  </button>
                </div>
              </div>

              <div className="bg-[#0a0e17] rounded-xl p-3 border border-slate-800/80 font-mono text-[11px] sm:text-xs h-48 overflow-y-auto flex flex-col gap-1 text-slate-300">
                {filteredLogs.length === 0 ? (
                  <div className="text-slate-500 text-center py-6">暂无日志记录</div>
                ) : (
                  filteredLogs.map((l) => (
                    <div
                      key={l.id}
                      className={`leading-relaxed break-all ${
                        l.type === 'error'
                          ? 'text-red-400 font-semibold'
                          : l.type === 'warn'
                          ? 'text-amber-400'
                          : l.type === 'success'
                          ? 'text-emerald-300'
                          : 'text-slate-300'
                      }`}
                    >
                      <span className="text-slate-500 select-none">[{l.time}] </span>
                      {l.text}
                    </div>
                  ))
                )}
                <div ref={consoleBottomRef} />
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: TRANSMITTER & LAB */}
        {activeTab === 'transmitter' && (
          <div className="flex flex-col gap-4">
            <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 shadow-md flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Radio className="w-5 h-5 text-cyan-400" />
                <div>
                  <h2 className="font-bold text-white text-base">声学发射端与协议模拟实验室</h2>
                  <p className="text-xs text-slate-400">
                    无需第二台硬件设备，可直接在本地触发测试数据包注入、真实扬声器声波外放或容错测试。
                  </p>
                </div>
              </div>

              {/* Fast simulator buttons */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div className="bg-[#0a0e17] border border-slate-800 rounded-xl p-3.5 flex flex-col justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-sm text-cyan-300 mb-1">模拟正常传输 (分包注入)</h3>
                    <p className="text-xs text-slate-400">
                      快速生成 2.8KB 文本文件（Header 78B + 3个Chunk 1030B），模拟经 Quiet 解调后送入接收通道，检验自动组装与自动下载。
                    </p>
                  </div>
                  <button
                    onClick={handleSimulateNormalTransfer}
                    className="w-full py-2.5 px-4 bg-cyan-500 hover:bg-cyan-400 text-black font-bold rounded-xl text-xs sm:text-sm flex items-center justify-center gap-2"
                  >
                    <Zap className="w-4 h-4" />
                    <span>立即注入测试分包流</span>
                  </button>
                </div>

                <div className="bg-[#0a0e17] border border-slate-800 rounded-xl p-3.5 flex flex-col justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-sm text-amber-300 mb-1">模拟 CRC 错帧注入</h3>
                    <p className="text-xs text-slate-400">
                      构造一个故意修改末尾 CRC32 的坏帧，验证 IEEE 802.3 校验拦截、错帧计数器递增与丢弃机制。
                    </p>
                  </div>
                  <button
                    onClick={handleSimulateCorruptedPacket}
                    className="w-full py-2.5 px-4 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded-xl text-xs sm:text-sm flex items-center justify-center gap-2"
                  >
                    <AlertTriangle className="w-4 h-4" />
                    <span>注入损坏的 CRC 数据包</span>
                  </button>
                </div>
              </div>

              {/* Real Acoustic Transmitter */}
              <div className="bg-[#0a0e17] border border-slate-800 rounded-xl p-3.5 flex flex-col gap-3 mt-1">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-bold text-sm text-white">真实声波外放发射 (Quiet.transmitter)</h3>
                    <p className="text-xs text-slate-400">
                      使用 Quiet.js 的 cable-64k 调制引擎，将数据通过扬声器物理播发（~10.2kHz），供另一台手机或麦克风接收。
                    </p>
                  </div>
                  <span className="text-xs text-cyan-400 font-mono">QAM1024 / 10.2kHz</span>
                </div>

                <textarea
                  value={txText}
                  onChange={(e) => setTxText(e.target.value)}
                  rows={3}
                  className="w-full bg-[#121826] border border-slate-800 rounded-lg p-2.5 text-xs text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
                  placeholder="输入要发射的文本内容..."
                />

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleTransmitAcoustically}
                    disabled={isTransmitting}
                    className={`flex-1 py-3 px-4 rounded-xl font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all ${
                      isTransmitting
                        ? 'bg-slate-700 text-slate-400 cursor-not-allowed'
                        : 'bg-emerald-500 hover:bg-emerald-400 text-black shadow-md'
                    }`}
                  >
                    <Volume2 className="w-4 h-4" />
                    <span>{isTransmitting ? `正在声波外放 (${txProgress}%)...` : '通过扬声器物理发射声波'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: STANDALONE HTML CODE & EXPORT */}
        {activeTab === 'standalone' && (
          <div className="flex flex-col gap-4">
            <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 shadow-md flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-bold text-white text-base">单文件 index.html 代码</h2>
                  <p className="text-xs text-slate-400">
                    完全自包含的单文件实现，内置全部样式、CRC32、协议解析与三大防御机制。
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <a
                    href="/standalone-receiver.html"
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs flex items-center gap-1.5 border border-slate-700"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>新窗口独立运行</span>
                  </a>
                  <button
                    onClick={handleCopyStandaloneHtml}
                    className="px-3 py-1.5 bg-cyan-500 hover:bg-cyan-400 text-black font-semibold rounded-xl text-xs flex items-center gap-1.5"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>{copiedHtmlFeedback ? '已复制全部代码' : '一键复制完整代码'}</span>
                  </button>
                  <button
                    onClick={handleDownloadStandaloneHtml}
                    className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold rounded-xl text-xs flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>下载 index.html</span>
                  </button>
                </div>
              </div>

              {/* Code Viewer */}
              <div className="bg-[#0a0e17] rounded-xl p-3 border border-slate-800/80 font-mono text-[11px] h-96 overflow-y-auto text-slate-300">
                <pre>{standaloneHtmlCode || '// 正在载入 standalone-receiver.html 代码...'}</pre>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: PROTOCOL SPECIFICATION */}
        {activeTab === 'protocol' && (
          <div className="flex flex-col gap-4">
            <div className="bg-[#121826] border border-slate-800 rounded-2xl p-4 shadow-md flex flex-col gap-4">
              <div>
                <h2 className="font-bold text-white text-base">自定义分包协议与数据结构规范</h2>
                <p className="text-xs text-slate-400">
                  所有多字节整数均严格采用 Big-Endian（大端序），校验码遵循 IEEE 802.3 标准 CRC-32。
                </p>
              </div>

              {/* Header Spec */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-cyan-400" />
                  <h3 className="font-bold text-sm text-cyan-300">1. 元数据头 (Header) - 固定 78 字节</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="py-2 px-3">偏移 (Bytes)</th>
                        <th className="py-2 px-3">长度</th>
                        <th className="py-2 px-3">字段名称</th>
                        <th className="py-2 px-3">类型 / 编码</th>
                        <th className="py-2 px-3">描述</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                      <tr>
                        <td className="py-2 px-3 text-cyan-400">[0 - 3]</td>
                        <td className="py-2 px-3">4 B</td>
                        <td className="py-2 px-3 font-semibold text-white">Magic Number</td>
                        <td className="py-2 px-3">Uint32 (BE)</td>
                        <td className="py-2 px-3 font-sans text-slate-400">固定魔数 0xDEADBEEF，用于识别传输握手</td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 text-cyan-400">[4 - 67]</td>
                        <td className="py-2 px-3">64 B</td>
                        <td className="py-2 px-3 font-semibold text-white">Filename</td>
                        <td className="py-2 px-3">UTF-8 String</td>
                        <td className="py-2 px-3 font-sans text-slate-400">文件名，不足 64 字节的部分在尾部补 \0</td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 text-cyan-400">[68 - 71]</td>
                        <td className="py-2 px-3">4 B</td>
                        <td className="py-2 px-3 font-semibold text-white">Total File Size</td>
                        <td className="py-2 px-3">Uint32 (BE)</td>
                        <td className="py-2 px-3 font-sans text-slate-400">文件原始总字节数（组装时据此截断补零）</td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 text-cyan-400">[72 - 73]</td>
                        <td className="py-2 px-3">2 B</td>
                        <td className="py-2 px-3 font-semibold text-white">Total Chunks</td>
                        <td className="py-2 px-3">Uint16 (BE)</td>
                        <td className="py-2 px-3 font-sans text-slate-400">分块总数量（从序号 0 到 Total-1）</td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 text-cyan-400">[74 - 77]</td>
                        <td className="py-2 px-3">4 B</td>
                        <td className="py-2 px-3 font-semibold text-white">File CRC32</td>
                        <td className="py-2 px-3">Uint32 (BE)</td>
                        <td className="py-2 px-3 font-sans text-slate-400">文件全局原始字节的标准 IEEE 802.3 CRC32 校验码</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Data Chunk Spec */}
              <div className="flex flex-col gap-2 mt-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <h3 className="font-bold text-sm text-emerald-300">2. 数据块 (Data Chunk) - 固定 1030 字节</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400">
                        <th className="py-2 px-3">偏移 (Bytes)</th>
                        <th className="py-2 px-3">长度</th>
                        <th className="py-2 px-3">字段名称</th>
                        <th className="py-2 px-3">类型 / 编码</th>
                        <th className="py-2 px-3">描述</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                      <tr>
                        <td className="py-2 px-3 text-emerald-400">[0 - 1]</td>
                        <td className="py-2 px-3">2 B</td>
                        <td className="py-2 px-3 font-semibold text-white">Chunk Index</td>
                        <td className="py-2 px-3">Uint16 (BE)</td>
                        <td className="py-2 px-3 font-sans text-slate-400">当前数据块序号（从 0 开始递增）</td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 text-emerald-400">[2 - 1025]</td>
                        <td className="py-2 px-3">1024 B</td>
                        <td className="py-2 px-3 font-semibold text-white">Payload Area</td>
                        <td className="py-2 px-3">Raw Bytes</td>
                        <td className="py-2 px-3 font-sans text-slate-400">有效载荷（最后一块不足 1024 字节在尾部补零）</td>
                      </tr>
                      <tr>
                        <td className="py-2 px-3 text-emerald-400">[1026 - 1029]</td>
                        <td className="py-2 px-3">4 B</td>
                        <td className="py-2 px-3 font-semibold text-white">Payload CRC32</td>
                        <td className="py-2 px-3">Uint32 (BE)</td>
                        <td className="py-2 px-3 font-sans text-slate-400">针对该 1024 字节载荷区域计算的独立 CRC32 校验码</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Defense Rationale Guide */}
              <div className="bg-[#0a0e17] rounded-xl p-4 border border-slate-800 text-xs flex flex-col gap-2 mt-2">
                <h4 className="font-bold text-white flex items-center gap-1.5">
                  <Info className="w-4 h-4 text-cyan-400" />
                  <span>三大底层防御架构说明</span>
                </h4>
                <ul className="list-disc list-inside text-slate-400 space-y-1.5 leading-relaxed font-sans">
                  <li>
                    <strong className="text-slate-200">移动端麦克风拦截防御：</strong> Android Chrome/Edge 严禁非用户手势触发的麦克风请求，亦不允许延迟在 setTimeout 中申请。系统在用户点击按钮后，于同一调用栈同步调用 navigator.mediaDevices.getUserMedia，捕获流后注入并转交 Quiet.js。
                  </li>
                  <li>
                    <strong className="text-slate-200">Emscripten 内存寻址防御：</strong> 在引入 quiet.js 之前重写 window.Module.locateFile，将所有对 quiet-emscripten.js.mem 的寻址重定向至绝对路径，彻底消除 404 及 abort() 崩溃。
                  </li>
                  <li>
                    <strong className="text-slate-200">底层函数兼容性防御：</strong> 官方编译版本常丢失 ccall 与 intArrayFromString，在 window.Module 初始化前注入全功能 UTF-8 兼容版本，彻底杜绝 undefined is not a function 异常。
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
