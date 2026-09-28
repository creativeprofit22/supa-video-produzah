#include <windows.h>
#include <string>
#include <iostream>
#include <thread>
#include <atomic>
#include <set>

static unsigned long long token(HANDLE p) {
 FILETIME c,e,k,u; if(!GetProcessTimes(p,&c,&e,&k,&u)) return 0;
 return (static_cast<unsigned long long>(c.dwHighDateTime)<<32)|c.dwLowDateTime;
}
// CommandLineToArgvW/MS CRT quoting, including trailing backslashes.
static std::wstring quote(const std::wstring& s) {
 std::wstring r=L"\""; size_t n=0;
 for(wchar_t c:s) { if(c==L'\\') {++n;continue;} r.append(c==L'"'?2*n+1:n,L'\\');r+=c;n=0; }
 r.append(2*n,L'\\');return r+L"\"";
}
struct Lookup {DWORD pid; HWND hwnd=nullptr;};
static BOOL CALLBACK windowProc(HWND w, LPARAM data) {
 auto& l=*reinterpret_cast<Lookup*>(data);DWORD pid=0;GetWindowThreadProcessId(w,&pid);
 if(pid==l.pid && IsWindowVisible(w) && !GetWindow(w,GW_OWNER)) {l.hwnd=w;return FALSE;}return TRUE;
}
int wmain(int argc,wchar_t** argv) {
 if(argc>1 && std::wstring(argv[1]).rfind(L"--user-data-dir=",0)==0) {Sleep(60000);return 0;}
 if(argc>=2 && std::wstring(argv[1])==L"--qpc") {LARGE_INTEGER t;QueryPerformanceCounter(&t);std::cout<<t.QuadPart<<std::endl;return 0;}
 if(argc>=2 && std::wstring(argv[1])==L"--fixture-exit") return 17;
 if(argc>=2 && std::wstring(argv[1])==L"--fixture-wait") {Sleep(60000);return 0;}
 if(argc>=2 && std::wstring(argv[1])==L"--fixture-tree") {
  wchar_t exe[32768];GetModuleFileNameW(nullptr,exe,32768);std::wstring cmd=quote(exe)+L" --fixture-wait";
  STARTUPINFOW si{};si.cb=sizeof(si);PROCESS_INFORMATION pi{};
  if(!CreateProcessW(exe,cmd.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&si,&pi))return 18;
  CloseHandle(pi.hThread);CloseHandle(pi.hProcess);Sleep(60000);return 0;
 }
 if(argc<4)return 2;
 DWORD lease=wcstoul(argv[1],nullptr,10);if(lease<100||lease>1800000)return 2;
 HANDLE job=CreateJobObjectW(nullptr,nullptr);if(!job)return 3;
 JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
 if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) {CloseHandle(job);return 4;}
 HANDLE completion=CreateIoCompletionPort(INVALID_HANDLE_VALUE,nullptr,0,1);
 JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{};association.CompletionKey=job;association.CompletionPort=completion;
 if(!completion || !SetInformationJobObject(job,JobObjectAssociateCompletionPortInformation,&association,sizeof(association))) {CloseHandle(job);return 4;}
 std::wstring cmd;for(int i=2;i<argc;i++){if(i>2)cmd+=L' ';cmd+=quote(argv[i]);}
 STARTUPINFOW si{};si.cb=sizeof(si);PROCESS_INFORMATION pi{};
 if(!CreateProcessW(argv[2],cmd.data(),nullptr,nullptr,FALSE,CREATE_SUSPENDED,nullptr,nullptr,&si,&pi)) {std::cout<<"{\"event\":\"setup-error\",\"win32\":"<<GetLastError()<<"}"<<std::endl;CloseHandle(job);CloseHandle(completion);return 5;}
 auto creation=token(pi.hProcess);
 if(!creation || !AssignProcessToJobObject(job,pi.hProcess)) {
  TerminateProcess(pi.hProcess,91);WaitForSingleObject(pi.hProcess,5000);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);CloseHandle(completion);return 6;
 }
 std::cout<<"{\"event\":\"identity\",\"pid\":"<<pi.dwProcessId<<",\"creation\":\""<<creation<<"\"}"<<std::endl;
 if(ResumeThread(pi.hThread)==DWORD(-1)) {TerminateProcess(pi.hProcess,92);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(job);CloseHandle(completion);return 7;}CloseHandle(pi.hThread);
 std::atomic<bool> stop=false;
 std::thread reader([&] {std::string line;while(std::getline(std::cin,line)) {
  if(line=="stop")break;
  if(line.rfind("find ",0)==0) {
   auto split=line.find(' ',5);bool valid=false;Lookup lookup{pi.dwProcessId};
   if(split!=std::string::npos) {try {valid=line.substr(5,split-5)==std::to_string(pi.dwProcessId) && line.substr(split+1)==std::to_string(creation) && token(pi.hProcess)==creation && WaitForSingleObject(pi.hProcess,0)==WAIT_TIMEOUT;}catch(...) {}}
   if(valid)EnumWindows(windowProc,reinterpret_cast<LPARAM>(&lookup));
   std::cout<<"{\"event\":\"window\",\"valid\":"<<(valid?"true":"false")<<",\"handle\":\""<<reinterpret_cast<ULONG_PTR>(lookup.hwnd)<<"\"}"<<std::endl;
  }
 }stop=true;});reader.detach();
 ULONGLONG deadline=GetTickCount64()+lease;
 while(!stop && GetTickCount64()<deadline && WaitForSingleObject(pi.hProcess,20)==WAIT_TIMEOUT) {}
 std::cout<<"{\"event\":\"closing-job\"}"<<std::endl;
 // Retain the job while draining exit notifications; close remains the crash fallback.
 TerminateJobObject(job,0); // only this job's members; no PID-based termination
 bool empty=false;std::set<ULONG_PTR> members;ULONGLONG end=GetTickCount64()+5000;
 while(GetTickCount64()<end) {
  DWORD message=0;ULONG_PTR key=0;LPOVERLAPPED value=nullptr;
  if(GetQueuedCompletionStatus(completion,&message,&key,&value,100)) {
   if(message==JOB_OBJECT_MSG_NEW_PROCESS)members.insert(reinterpret_cast<ULONG_PTR>(value));
   if(message==JOB_OBJECT_MSG_NEW_PROCESS || message==JOB_OBJECT_MSG_EXIT_PROCESS || message==JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS)
    std::cout<<"{\"event\":\"job-process\",\"message\":"<<message<<",\"pid\":"<<reinterpret_cast<ULONG_PTR>(value)<<"}"<<std::endl;
   if(message==JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO){empty=true;end=GetTickCount64()+200;}
  }
 }
 if(empty)for(auto pid:members)std::cout<<"{\"event\":\"owned-exit-confirmed\",\"pid\":"<<pid<<",\"proof\":\"JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO\"}"<<std::endl;
 WaitForSingleObject(pi.hProcess,1000);DWORD code=STILL_ACTIVE;GetExitCodeProcess(pi.hProcess,&code);
 std::cout<<"{\"event\":\"closed\",\"rootExit\":"<<code<<",\"empty\":"<<(empty?"true":"false")<<"}"<<std::endl;
 CloseHandle(job);CloseHandle(pi.hProcess);CloseHandle(completion);
 // Detached blocking stdin reader must not outlive stack storage.
 ExitProcess(empty?0:8);
}
