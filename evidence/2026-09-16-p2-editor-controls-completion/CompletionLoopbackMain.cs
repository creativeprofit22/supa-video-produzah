using System;
using System.Diagnostics;
public static class CompletionLoopbackMain {
    [MTAThread] public static int Main(string[] args) {
        if (args.Length != 2) return 2;
        int seconds = int.Parse(args[1]);
        if (seconds < 1 || seconds > 3) return 2;
        using (var process = Process.GetCurrentProcess())
            Console.WriteLine("READER_WAITING " + process.Id + " " + process.StartTime.ToFileTimeUtc());
        // Acknowledge exact process identity before any audio client is opened.
        if (Console.ReadLine() != "BEGIN_AUTHORIZED_CAPTURE") return 2;
        CompletionLoopbackCapture.Run(args[0], seconds);
        Console.WriteLine("READER_CAPTURE_STOPPED");
        // Keep the verified reader identity alive until the isolation observer
        // acknowledges its own shutdown. No samples are collected here.
        return Console.ReadLine() == "EXIT_OWNED_READER" ? 0 : 2;
    }
}
