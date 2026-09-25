#include <windows.h>
#include <iostream>
#include <string>
#include <thread>
#include <atomic>
#include <vector>

static unsigned long long creation(HANDLE p) {
  FILETIME c,e,k,u;
  if (!GetProcessTimes(p,&c,&e,&k,&u)) return 0;
  return (static_cast<unsigned long long>(c.dwHighDateTime)<<32)|c.dwLowDateTime;
}
static std::wstring quote(const std::wstring& s) {
  std::wstring out=L"\""; size_t slashes=0;
  for (wchar_t c:s) {
    if (c==L'\\') { ++slashes; continue; }
    out.append(c==L'"'?2*slashes+1:slashes,L'\\'); out+=c; slashes=0;
  }
  out.append(2*slashes,L'\\'); return out+L"\"";
}
int wmain(int argc,wchar_t** argv) {
  if (argc==2 && std::wstring(argv[1])==L"--fixture-child") { Sleep(10000); return 0; }
  if (argc==2 && std::wstring(argv[1])==L"--fixture-tree") {
    wchar_t exe[32768]; GetModuleFileNameW(nullptr,exe,32768);
    std::wstring cmd=quote(exe)+L" --fixture-child";
    STARTUPINFOW si{}; si.cb=sizeof(si); PROCESS_INFORMATION pi{};
    if (!CreateProcessW(exe,cmd.data(),nullptr,nullptr,FALSE,0,nullptr,nullptr,&si,&pi)) return 10;
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess); Sleep(10000); return 0;
  }
  if (argc<3) return 2;
  wchar_t* end=nullptr; unsigned long lease=wcstoul(argv[1],&end,10);
  if (!end || *end || lease<100 || lease>4500000) return 2;
  HANDLE job=CreateJobObjectW(nullptr,nullptr);
  if (!job) return 3;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))) { CloseHandle(job); return 4; }
  std::wstring cmd;
  for (int i=2;i<argc;i++) { if(i>2) cmd+=L' '; cmd+=quote(argv[i]); }
  // Never let the child initialize Node stdio from the launcher's control pipes.
  // Inherit only an explicit NUL handle; launcher identity/cleanup stay on its own stdout.
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES),nullptr,TRUE};
  HANDLE nullIo=CreateFileW(L"NUL",GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
  if (nullIo==INVALID_HANDLE_VALUE) { CloseHandle(job); return 11; }
  SIZE_T attributeBytes=0;
  InitializeProcThreadAttributeList(nullptr,1,0,&attributeBytes);
  if (!attributeBytes) { CloseHandle(nullIo); CloseHandle(job); return 12; }
  std::vector<unsigned char> attributes(attributeBytes);
  STARTUPINFOEXW si{}; si.StartupInfo.cb=sizeof(si);
  si.lpAttributeList=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
  if (!InitializeProcThreadAttributeList(si.lpAttributeList,1,0,&attributeBytes)) { CloseHandle(nullIo); CloseHandle(job); return 12; }
  if (!UpdateProcThreadAttribute(si.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,&nullIo,sizeof(nullIo),nullptr,nullptr)) {
    DeleteProcThreadAttributeList(si.lpAttributeList); CloseHandle(nullIo); CloseHandle(job); return 13;
  }
  si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput=nullIo; si.StartupInfo.hStdOutput=nullIo; si.StartupInfo.hStdError=nullIo;
  PROCESS_INFORMATION pi{};
  BOOL created=CreateProcessW(argv[2],cmd.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&si.StartupInfo,&pi);
  DeleteProcThreadAttributeList(si.lpAttributeList); CloseHandle(nullIo);
  if (!created) { CloseHandle(job); return 5; }
  if (!creation(pi.hProcess) || !AssignProcessToJobObject(job,pi.hProcess)) {
    TerminateProcess(pi.hProcess,91); WaitForSingleObject(pi.hProcess,5000);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(job); return 6;
  }
  std::cout<<"{\"event\":\"identity\",\"pid\":"<<pi.dwProcessId<<",\"creation\":\""<<creation(pi.hProcess)<<"\"}"<<std::endl;
  if (ResumeThread(pi.hThread)==DWORD(-1)) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); CloseHandle(job); return 7; }
  CloseHandle(pi.hThread);
  std::atomic<bool> stop{false};
  std::thread reader([&] { std::string line; std::getline(std::cin,line); stop=true; });
  reader.detach();
  ULONGLONG deadline=GetTickCount64()+lease;
  while (!stop && GetTickCount64()<deadline && WaitForSingleObject(pi.hProcess,25)==WAIT_TIMEOUT) {}
  DWORD rootExit=STILL_ACTIVE; GetExitCodeProcess(pi.hProcess,&rootExit);
  // Only this owned job is terminated. Closing the handle also protects abnormal launcher exits.
  TerminateJobObject(job,0);
  bool empty=false; ULONGLONG drain=GetTickCount64()+10000;
  do {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
    if (QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&info,sizeof(info),nullptr) && info.ActiveProcesses==0) { empty=true; break; }
    Sleep(20);
  } while (GetTickCount64()<drain);
  std::cout<<"{\"event\":\"closed\",\"rootExitBeforeCleanup\":"<<rootExit<<",\"empty\":"<<(empty?"true":"false")<<"}"<<std::endl;
  CloseHandle(pi.hProcess); CloseHandle(job);
  // The detached stdin reader must not survive storage referenced above.
  ExitProcess(empty?0:8);
}
