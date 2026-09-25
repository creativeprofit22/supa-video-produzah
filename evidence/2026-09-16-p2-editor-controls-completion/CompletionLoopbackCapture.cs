using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// Bounded audio-only adaptation of inspected Loopback.Run. Reuses its COM declarations,
// adds first-packet acknowledgement, and has no microphone/window/desktop capture path.
public static class CompletionLoopbackCapture {
    public static void Run(string directory, int seconds) {
        if (seconds < 1 || seconds > 3 || Directory.Exists(directory)) throw new ArgumentException("New directory and 1..3 second bound required");
        Directory.CreateDirectory(directory);
        Enumerator enumerator = null; Device device = null; AudioClient client = null;
        CaptureClient capture = null; IntPtr format = IntPtr.Zero; bool started = false, normal = false;
        try {
            enumerator = (Enumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
            enumerator.GetDefaultAudioEndpoint(0, 0, out device); // eRender only
            Guid iid = typeof(AudioClient).GUID; object value; device.Activate(ref iid, 23, IntPtr.Zero, out value); client = (AudioClient)value;
            client.GetMixFormat(out format);
            int fmtSize = 18 + (ushort)Marshal.ReadInt16(format,16);
            if (fmtSize > 128) throw new InvalidOperationException("Format bound");
            byte[] fmt = new byte[fmtSize]; Marshal.Copy(format,fmt,0,fmtSize);
            int rate = BitConverter.ToInt32(fmt,4), align = BitConverter.ToUInt16(fmt,12);
            int tag = BitConverter.ToUInt16(fmt,0); bool floating = tag == 3;
            if (tag == 65534 && fmtSize == 40) { byte[] guid = new byte[16]; Array.Copy(fmt,24,guid,0,16); floating = new Guid(guid) == new Guid("00000003-0000-0010-8000-00aa00389b71"); }
            if (!floating || rate != 48000 || align != 8 || BitConverter.ToUInt16(fmt,14) != 32) throw new InvalidOperationException("Unsupported endpoint format");
            client.Initialize(0,0x00020000,1000000,0,format,IntPtr.Zero);
            iid = typeof(CaptureClient).GUID; client.GetService(ref iid,out value); capture=(CaptureClient)value;
            long latency; client.GetStreamLatency(out latency);
            string clock = Path.Combine(directory,"clock.txt");
            File.WriteAllText(clock,"qpcFrequency="+Stopwatch.Frequency+"\nsampleRate="+rate+"\nblockAlign="+align+"\nstreamLatency100ns="+latency+"\nwindow=0\nNo latency subtraction.\n");
            using(var memory=new MemoryStream()) using(var wav=new BinaryWriter(memory)) using(var packets=new StringWriter()) {
                wav.Write(Encoding.ASCII.GetBytes("RIFF")); wav.Write(0); wav.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); wav.Write(fmt.Length); wav.Write(fmt);
                wav.Write(Encoding.ASCII.GetBytes("data")); long sizeAt=memory.Position; wav.Write(0); long dataStart=memory.Position;
                packets.WriteLine("byteOffset,frames,flags,devicePosition,qpc100ns,readQpcTicks");
                long startBefore=Stopwatch.GetTimestamp(); client.Start(); started=true; long start=Stopwatch.GetTimestamp();
                File.AppendAllText(clock,"startBeforeQpcTicks="+startBefore+"\nstartAfterQpcTicks="+start+"\n"); Console.WriteLine("LOOPBACK_READY");
                int packetCount=0; long frameCount=0; bool ready=false; float preplayPeak=0;
                try {
                    while((Stopwatch.GetTimestamp()-start)/(double)Stopwatch.Frequency < seconds) {
                        uint available; capture.GetNextPacketSize(out available);
                        while(available != 0) {
                            IntPtr data; uint frames,flags; ulong position,qpc; capture.GetBuffer(out data,out frames,out flags,out position,out qpc);
                            try {
                                if(frames > rate/10 || ++packetCount > 4096 || memory.Length + frames*align > 2000000) throw new InvalidOperationException("Capture size bound");
                                byte[] bytes=new byte[checked((int)frames*align)]; if((flags & 2)==0) Marshal.Copy(data,bytes,0,bytes.Length);
                                packets.WriteLine((memory.Position-dataStart)+","+frames+","+flags+","+position+","+qpc+","+Stopwatch.GetTimestamp()); wav.Write(bytes); frameCount+=frames;
                                if(!ready) {
                                    for(int i=0;i<bytes.Length;i+=4) { float sample=BitConverter.ToSingle(bytes,i); if(Single.IsNaN(sample)||Single.IsInfinity(sample))throw new InvalidOperationException("Invalid PCM"); preplayPeak=Math.Max(preplayPeak,Math.Abs(sample)); }
                                    if(preplayPeak > 0.005) throw new InvalidOperationException("Unexpected pre-play sound");
                                    if(frameCount >= rate/20) { ready=true; Console.WriteLine("AUDIO_PACKETS_READY frames="+frameCount+" peak="+preplayPeak); }
                                }
                            } finally { capture.ReleaseBuffer(frames); }
                            capture.GetNextPacketSize(out available);
                        }
                        Thread.Sleep(1);
                    }
                    if(!ready) throw new InvalidOperationException("No bounded pre-play packet readiness"); normal=true;
                } finally {
                    long stopBefore=Stopwatch.GetTimestamp(); client.Stop(); started=false; long stopAfter=Stopwatch.GetTimestamp();
                    File.AppendAllText(clock,"stopBeforeQpcTicks="+stopBefore+"\nstopAfterQpcTicks="+stopAfter+"\n");
                    long end=memory.Position; wav.Seek((int)sizeAt,SeekOrigin.Begin); wav.Write((int)(end-dataStart)); wav.Seek(4,SeekOrigin.Begin); wav.Write((int)(end-8));
                    File.WriteAllBytes(Path.Combine(directory,"loopback.wav"),memory.ToArray()); File.WriteAllText(Path.Combine(directory,"packets.csv"),packets.ToString());
                    Console.WriteLine(normal ? "AUDIO_STOP_ACK" : "AUDIO_STOP_ABNORMAL");
                }
            }
        } finally {
            if(started) client.Stop(); if(format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
            Release(capture); Release(client); Release(device); Release(enumerator);
        }
    }
    static void Release(object value) { if(value != null && Marshal.IsComObject(value))Marshal.FinalReleaseComObject(value); }
}
