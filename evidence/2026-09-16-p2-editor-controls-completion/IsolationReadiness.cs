// Read-only endpoint session readiness. Compiled with the inspected SessionPreflight.cs
// interfaces; never opens an audio capture client or calls session mutation methods.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class IsolationReadiness {
    static void Release(object value) {
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }
    public static int Inspect() {
        PFEnumerator enumerator = null;
        PFDevice device = null;
        object manager = null;
        PFSessions sessions = null;
        try {
            enumerator = (PFEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(
                new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
            enumerator.GetDefaultAudioEndpoint(0, 0, out device);
            Guid iid = typeof(PFManager).GUID;
            device.Activate(ref iid, 23, IntPtr.Zero, out manager);
            ((PFManager)manager).GetSessionEnumerator(out sessions);
            int count; sessions.GetCount(out count);
            if (count < 0 || count > 256) throw new InvalidOperationException("Invalid session count");
            int unmuted = 0;
            for (int i = 0; i < count; i++) {
                object session = null;
                try {
                    sessions.GetSession(i, out session);
                    var control = (PFControl)session;
                    int state; control.GetState(out state);
                    if (state < 0 || state > 2) throw new InvalidOperationException("Unknown state");
                    bool mute; ((PFVolume)session).GetMute(out mute);
                    if (state == 2 || mute) continue;
                    unmuted++;
                    uint pid; int result = control.GetProcessId(out pid);
                    Marshal.ThrowExceptionForHR(result);
                    int system = control.IsSystemSoundsSession();
                    Marshal.ThrowExceptionForHR(system);
                    if (system != 0 && system != 1) throw new InvalidOperationException("Unknown system result");
                    string name = system == 0 ? "Windows system sounds" : "unresolved process";
                    if (system == 1 && result == 0 && pid > 0 && pid <= Int32.MaxValue) {
                        using (var process = Process.GetProcessById((int)pid)) name = process.ProcessName;
                    }
                    // No paths, session identifiers, endpoint IDs or command lines.
                    Console.WriteLine("UNMUTED_SESSION state=" + state + " singleProcess=" + (result == 0) + " app=" + name + " pid=" + pid);
                } finally { Release(session); }
            }
            Console.WriteLine("READINESS unmutedForeignSessions=" + unmuted + "; captureStarted=false; mutationCalls=0");
            return unmuted == 0 ? 0 : 2;
        } finally { Release(sessions); Release(manager); Release(device); Release(enumerator); }
    }
}
