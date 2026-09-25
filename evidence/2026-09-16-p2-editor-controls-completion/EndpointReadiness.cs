using System;
using System.Runtime.InteropServices;

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface CompletionEndpoints {
    void GetCount(out uint count);
    void Item(uint index, out PFDevice device);
}

// Read-only survey of active render endpoints; no device setting or recording.
public static class EndpointReadiness {
    static void Release(object value) {
        if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
    }
    public static void Inspect() {
        PFEnumerator enumerator = null; PFDevice defaultDevice = null;
        CompletionEndpoints endpoints = null; IntPtr pointer = IntPtr.Zero;
        try {
            enumerator = (PFEnumerator)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
            enumerator.GetDefaultAudioEndpoint(0, 0, out defaultDevice);
            string defaultId; defaultDevice.GetId(out defaultId);
            enumerator.EnumAudioEndpoints(0, 1, out pointer);
            endpoints = (CompletionEndpoints)Marshal.GetObjectForIUnknown(pointer);
            Marshal.Release(pointer); pointer = IntPtr.Zero;
            uint count; endpoints.GetCount(out count);
            if (count > 64) throw new InvalidOperationException("Endpoint enumeration bound exceeded");
            for (uint index = 0; index < count; index++) {
                PFDevice device = null; object manager = null; PFSessions sessions = null;
                try {
                    endpoints.Item(index, out device); string id; device.GetId(out id);
                    Guid iid = typeof(PFManager).GUID; device.Activate(ref iid, 23, IntPtr.Zero, out manager);
                    ((PFManager)manager).GetSessionEnumerator(out sessions);
                    int total; sessions.GetCount(out total);
                    if (total < 0 || total > 256) throw new InvalidOperationException("Session bound exceeded");
                    int unmuted = 0, active = 0;
                    for (int i = 0; i < total; i++) {
                        object session = null;
                        try {
                            sessions.GetSession(i, out session); int state; ((PFControl)session).GetState(out state);
                            bool mute; ((PFVolume)session).GetMute(out mute);
                            if (state == 1) active++;
                            if (state != 2 && !mute) unmuted++;
                        } finally { Release(session); }
                    }
                    Console.WriteLine("ENDPOINT index=" + index + " default=" + (id == defaultId) + " sessions=" + total + " active=" + active + " unmuted=" + unmuted);
                } finally { Release(sessions); Release(manager); Release(device); }
            }
            Console.WriteLine("READ_ONLY captureStarted=false mutationCalls=0");
        } finally { if (pointer != IntPtr.Zero) Marshal.Release(pointer); Release(endpoints); Release(defaultDevice); Release(enumerator); }
    }
}
