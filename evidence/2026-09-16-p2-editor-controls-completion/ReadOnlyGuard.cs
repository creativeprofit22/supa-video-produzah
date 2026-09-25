using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

// Reuses inspected COM declarations/identity and notification helpers only.
// This entry point never instantiates LiveGuardian or any mute/restoration core.
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class CompletionReadOnlyGuard : GNotification {
    sealed class Retained {
        public object Value; public PFControl Control; public PFVolume Volume;
        public SessionEvents Events; public bool Registered;
    }
    readonly object gate = new object();
    readonly ManualResetEvent stop = new ManualResetEvent(false);
    readonly Dictionary<string, Retained> sessions = new Dictionary<string, Retained>();
    OwnedIdentity owned, reader; bool invalid;
    void Fail() { lock(gate) { invalid = true; stop.Set(); Console.WriteLine("ISOLATION_INVALID"); } }
    void InspectSession(object value) {
        lock (gate) {
            var control = (PFControl)value; string id; control.GetSessionInstanceIdentifier(out id);
            if (String.IsNullOrEmpty(id)) throw new InvalidOperationException("No session identity");
            if (sessions.ContainsKey(id)) return;
            int state; control.GetState(out state); if (state == 2) return;
            uint pid; int result = control.GetProcessId(out pid); Marshal.ThrowExceptionForHR(result);
            int system = control.IsSystemSoundsSession();
            if (system != 0 && system != 1) throw new InvalidOperationException("Unknown session kind");
            if (system == 1 && result == 0 && pid != 0 && (owned.IsOwned(pid) || (reader != null && reader.IsOwned(pid)))) return;
            var volume = (PFVolume)value; bool mute; volume.GetMute(out mute);
            if (!mute) throw new InvalidOperationException("Foreign unmuted or ambiguous audio session pid=" + pid + " state=" + state);
            var item = new Retained { Value = value, Control = control, Volume = volume };
            item.Events = new SessionEvents(Guid.NewGuid(), Fail);
            SessionEvents.RegisterAndVerify(() => control.RegisterAudioSessionNotification(item.Events), () => item.Registered = true,
                () => { bool current; volume.GetMute(out current); return current; }, true);
            if (sessions.Count >= 256) throw new InvalidOperationException("Retained session bound");
            sessions.Add(id, item);
        }
    }
    public int OnSessionCreated(object value) { try { InspectSession(value); } catch (Exception error) { Console.Error.WriteLine("ISOLATION_REJECTED " + error.Message); Fail(); } return 0; }
    [MTAThread] public static int Main(string[] args) {
        if (args.Length != 3 && args.Length != 6) return 2;
        try { return new CompletionReadOnlyGuard().Run(args); }
        catch (Exception error) { Console.Error.WriteLine("ISOLATION_REJECTED " + error.Message); return 1; }
    }
    int Run(string[] args) {
        uint pid = uint.Parse(args[0]); long creation = long.Parse(args[1]); string executable = args[2];
        PFEnumerator enumerator = null; PFDevice device = null; object manager = null;
        bool registered = false;
        try {
            owned = new OwnedIdentity(pid,creation); owned.ValidateExecutable(executable);
            if (args.Length == 6) { reader = new OwnedIdentity(uint.Parse(args[3]),long.Parse(args[4])); reader.ValidateExecutable(args[5]); }
            enumerator = (PFEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
            enumerator.GetDefaultAudioEndpoint(0,0,out device); string initialId; device.GetId(out initialId);
            Guid iid = typeof(PFManager).GUID; device.Activate(ref iid,23,IntPtr.Zero,out manager);
            var audioManager = (PFManager)manager;
            audioManager.RegisterSessionNotification(this); registered = true;
            var inputThread = new Thread(() => { try { Console.ReadLine(); } finally { stop.Set(); } }); inputThread.IsBackground = true; inputThread.Start();
            var clock = Stopwatch.StartNew(); bool ready = false;
            while (!stop.WaitOne(0)) {
                if (clock.ElapsedMilliseconds >= 60000 || !owned.Alive) throw new InvalidOperationException("Owned identity/lease ended");
                PFDevice current = null; PFSessions list = null;
                try {
                    enumerator.GetDefaultAudioEndpoint(0,0,out current); string currentId; current.GetId(out currentId);
                    if (currentId != initialId) throw new InvalidOperationException("Endpoint changed");
                    audioManager.GetSessionEnumerator(out list); int count; list.GetCount(out count);
                    if (count < 0 || count > 256) throw new InvalidOperationException("Session enumeration bound");
                    for (int i=0;i<count;i++) { object value; list.GetSession(i,out value); InspectSession(value); }
                    lock(gate) {
                        foreach (var item in sessions.Values) { bool mute; item.Volume.GetMute(out mute); if (!mute || item.Events.Invalid) throw new InvalidOperationException("Foreign session changed"); }
                        if (invalid) throw new InvalidOperationException("Isolation invalidated");
                    }
                    if (!ready) { Console.WriteLine("ISOLATION_READY mutationCalls=0"); ready=true; }
                } finally { Release(list); Release(current); }
                stop.WaitOne(25);
            }
            if (invalid) return 1;
            Console.WriteLine("ISOLATION_STOPPED mutationCalls=0"); return 0;
        } finally {
            if (registered) ((PFManager)manager).UnregisterSessionNotification(this);
            foreach (var item in sessions.Values) { if (item.Registered) item.Control.UnregisterAudioSessionNotification(item.Events); Release(item.Value); }
            Release(manager); Release(device); Release(enumerator); if (owned != null) owned.Dispose(); if (reader != null) reader.Dispose();
        }
    }
    static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }
}
