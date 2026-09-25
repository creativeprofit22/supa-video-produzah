// Separate, explicitly user-authorized preparation; never called by the capture guard.
// Compiled with the reviewed SessionPreflight.cs COM declarations. No recording APIs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class AuthorizedOutputMute {
    static void Release(object value) { if(value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }
    public static void Mute(int pid, string expectedExecutable, long expectedCreation) {
        if(pid != 3824 && pid != 16400) throw new InvalidOperationException("Not one of the two user-authorized output processes");
        using(var process = Process.GetProcessById(pid)) {
            if(process.StartTime.ToUniversalTime().ToFileTimeUtc() != expectedCreation ||
               !String.Equals(process.MainModule.FileName, expectedExecutable, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Process identity changed");
            PFEnumerator enumerator=null; PFDevice device=null; object manager=null; PFSessions sessions=null;
            var retained = new List<object>();
            try {
                enumerator=(PFEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
                enumerator.GetDefaultAudioEndpoint(0,0,out device); // render/output only
                Guid iid=typeof(PFManager).GUID; device.Activate(ref iid,23,IntPtr.Zero,out manager);
                ((PFManager)manager).GetSessionEnumerator(out sessions); int count; sessions.GetCount(out count);
                if(count<0 || count>256) throw new InvalidOperationException("Session bound");
                for(int i=0;i<count;i++) {
                    object session; sessions.GetSession(i,out session); bool keep=false;
                    try {
                        var control=(PFControl)session; uint sessionPid; int single=control.GetProcessId(out sessionPid); Marshal.ThrowExceptionForHR(single);
                        int state; control.GetState(out state);
                        if(sessionPid==(uint)pid && state!=2) {
                            if(single!=0 || control.IsSystemSoundsSession()!=1) throw new InvalidOperationException("Ambiguous/system session");
                            retained.Add(session); keep=true;
                        }
                    } finally { if(!keep) Release(session); }
                }
                if(retained.Count<1 || retained.Count>8 || process.HasExited) throw new InvalidOperationException("Authorized sessions unavailable");
                foreach(object session in retained) {
                    int state; ((PFControl)session).GetState(out state);
                    if(state==2 || process.HasExited) throw new InvalidOperationException("Session expired");
                    var volume=(PFVolume)session; bool before,after; volume.GetMute(out before);
                    volume.SetMute(true,IntPtr.Zero); volume.GetMute(out after);
                    Console.WriteLine("AUTHORIZED_OUTPUT_MUTE pid="+pid+" beforeMuted="+before+" afterMuted="+after+" recording=false microphoneChanged=false volumeLevelChanged=false");
                    if(!after) throw new InvalidOperationException("Mute not confirmed");
                }
            } finally { foreach(object session in retained) Release(session); Release(sessions); Release(manager); Release(device); Release(enumerator); }
        }
    }
}
