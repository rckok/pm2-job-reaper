'use strict';

/**
 * Minimal kernel32 bindings (via koffi) for Job Objects, process handles and
 * process enumeration. Handles are plain JS numbers (intptr_t).
 */

const koffi = require('koffi');

const C = Object.freeze({
  PROCESS_TERMINATE: 0x0001,
  PROCESS_DUP_HANDLE: 0x0040,
  PROCESS_SET_QUOTA: 0x0100,
  PROCESS_QUERY_LIMITED_INFORMATION: 0x1000,
  SYNCHRONIZE: 0x00100000,
  JOB_OBJECT_ALL_ACCESS: 0x1f003f,
  TH32CS_SNAPPROCESS: 0x2,
  DUPLICATE_CLOSE_SOURCE: 0x1,
  DUPLICATE_SAME_ACCESS: 0x2,
  WAIT_OBJECT_0: 0x0,
  ERROR_ACCESS_DENIED: 5,
  ERROR_ALREADY_EXISTS: 183,
  JobObjectBasicAccountingInformation: 1,
});

const INVALID_HANDLE_VALUE = -1;

const FILETIME = koffi.struct('FILETIME', {
  lo: 'uint32_t',
  hi: 'uint32_t',
});

const PROCESSENTRY32W = koffi.struct('PROCESSENTRY32W', {
  dwSize: 'uint32_t',
  cntUsage: 'uint32_t',
  th32ProcessID: 'uint32_t',
  th32DefaultHeapID: 'uintptr_t',
  th32ModuleID: 'uint32_t',
  cntThreads: 'uint32_t',
  th32ParentProcessID: 'uint32_t',
  pcPriClassBase: 'int32_t',
  dwFlags: 'uint32_t',
  szExeFile: koffi.array('char16_t', 260, 'String'),
});

const JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = koffi.struct('JOBOBJECT_BASIC_ACCOUNTING_INFORMATION', {
  TotalUserTime: 'int64_t',
  TotalKernelTime: 'int64_t',
  ThisPeriodTotalUserTime: 'int64_t',
  ThisPeriodTotalKernelTime: 'int64_t',
  TotalPageFaultCount: 'uint32_t',
  TotalProcesses: 'uint32_t',
  ActiveProcesses: 'uint32_t',
  TotalTerminatedProcesses: 'uint32_t',
});

const PROTOTYPES = {
  GetLastError: 'uint32_t __stdcall GetLastError()',
  GetCurrentProcess: 'intptr_t __stdcall GetCurrentProcess()',
  CloseHandle: 'int __stdcall CloseHandle(intptr_t h)',
  OpenProcess: 'intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)',
  WaitForSingleObject: 'uint32_t __stdcall WaitForSingleObject(intptr_t h, uint32_t ms)',
  GetProcessTimes:
    'int __stdcall GetProcessTimes(intptr_t h, _Out_ FILETIME *creation, _Out_ FILETIME *exit, _Out_ FILETIME *kernel, _Out_ FILETIME *user)',
  CreateJobObjectW: 'intptr_t __stdcall CreateJobObjectW(void *attrs, const char16_t *name)',
  OpenJobObjectW: 'intptr_t __stdcall OpenJobObjectW(uint32_t access, int inherit, const char16_t *name)',
  AssignProcessToJobObject: 'int __stdcall AssignProcessToJobObject(intptr_t job, intptr_t proc)',
  TerminateJobObject: 'int __stdcall TerminateJobObject(intptr_t job, uint32_t exitCode)',
  IsProcessInJob: 'int __stdcall IsProcessInJob(intptr_t proc, intptr_t job, _Out_ int *result)',
  QueryInformationJobObject:
    'int __stdcall QueryInformationJobObject(intptr_t job, int infoClass, _Out_ JOBOBJECT_BASIC_ACCOUNTING_INFORMATION *info, uint32_t len, uint32_t *retLen)',
  DuplicateHandle:
    'int __stdcall DuplicateHandle(intptr_t srcProc, intptr_t src, intptr_t dstProc, _Out_ intptr_t *dst, uint32_t access, int inherit, uint32_t options)',
  CreateToolhelp32Snapshot: 'intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)',
  Process32FirstW: 'int __stdcall Process32FirstW(intptr_t snap, _Inout_ PROCESSENTRY32W *entry)',
  Process32NextW: 'int __stdcall Process32NextW(intptr_t snap, _Inout_ PROCESSENTRY32W *entry)',
};

let fn = null;
function bind() {
  if (fn) return fn;
  const k32 = koffi.load('kernel32.dll');
  fn = {};
  for (const [name, proto] of Object.entries(PROTOTYPES)) fn[name] = k32.func(proto);
  return fn;
}
if (process.platform === 'win32') bind();

class Win32Error extends Error {
  constructor(call, code) {
    super(`${call} failed (Win32 error ${code})`);
    this.call = call;
    this.code = code;
  }
}

const lastError = () => fn.GetLastError();
const toHandle = (h) => Number(h);

/** Returns { h, err }. h is 0 on failure, with err holding the Win32 error. */
function openProcess(pid, access) {
  const h = toHandle(fn.OpenProcess(access, 0, pid));
  return h ? { h, err: 0 } : { h: 0, err: lastError() };
}

function closeHandle(h) {
  if (h) fn.CloseHandle(h);
}

/** Requires SYNCHRONIZE on the handle. */
function hasExited(h) {
  return fn.WaitForSingleObject(h, 0) === C.WAIT_OBJECT_0;
}

/** Process creation time as a decimal string of 100ns FILETIME units. */
function creationTime(h) {
  const c = {};
  if (!fn.GetProcessTimes(h, c, {}, {}, {})) throw new Win32Error('GetProcessTimes', lastError());
  return ((BigInt(c.hi) << 32n) | BigInt(c.lo)).toString();
}

function createJob(name) {
  const h = toHandle(fn.CreateJobObjectW(null, name));
  const err = lastError();
  if (!h) throw new Win32Error('CreateJobObjectW', err);
  return { h, existed: err === C.ERROR_ALREADY_EXISTS };
}

/** Returns the handle, or 0 if the named job no longer exists. */
function openJob(name) {
  return toHandle(fn.OpenJobObjectW(C.JOB_OBJECT_ALL_ACCESS, 0, name));
}

function assign(job, proc) {
  if (!fn.AssignProcessToJobObject(job, proc)) throw new Win32Error('AssignProcessToJobObject', lastError());
}

function isInJob(proc, job) {
  const out = [0];
  if (!fn.IsProcessInJob(proc, job, out)) throw new Win32Error('IsProcessInJob', lastError());
  return out[0] !== 0;
}

/** Number of live processes in the job, or null if the query failed. */
function activeProcessCount(job) {
  const info = {};
  const ok = fn.QueryInformationJobObject(
    job,
    C.JobObjectBasicAccountingInformation,
    info,
    koffi.sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION),
    null
  );
  return ok ? info.ActiveProcesses : null;
}

function terminateJob(job, exitCode) {
  if (!fn.TerminateJobObject(job, exitCode)) throw new Win32Error('TerminateJobObject', lastError());
}

/** Duplicates one of our handles into another process. Returns the remote handle value or null. */
function duplicateInto(targetProc, h) {
  const out = [0];
  const ok = fn.DuplicateHandle(fn.GetCurrentProcess(), h, targetProc, out, 0, 0, C.DUPLICATE_SAME_ACCESS);
  return ok ? Number(out[0]) : null;
}

/** Closes a handle that lives inside another process. */
function closeRemoteHandle(ownerProc, remote) {
  return !!fn.DuplicateHandle(ownerProc, remote, 0, null, 0, 0, C.DUPLICATE_CLOSE_SOURCE);
}

/** Snapshot of all processes: [{ pid, ppid, exe }]. */
function listProcesses() {
  const snap = toHandle(fn.CreateToolhelp32Snapshot(C.TH32CS_SNAPPROCESS, 0));
  if (snap === INVALID_HANDLE_VALUE || snap === 0) throw new Win32Error('CreateToolhelp32Snapshot', lastError());
  try {
    const list = [];
    const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) };
    let ok = fn.Process32FirstW(snap, entry);
    while (ok) {
      list.push({ pid: entry.th32ProcessID, ppid: entry.th32ParentProcessID, exe: entry.szExeFile });
      ok = fn.Process32NextW(snap, entry);
    }
    return list;
  } finally {
    fn.CloseHandle(snap);
  }
}

module.exports = {
  C,
  PROTOTYPES,
  structs: { FILETIME, PROCESSENTRY32W, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION },
  Win32Error,
  lastError,
  openProcess,
  closeHandle,
  hasExited,
  creationTime,
  createJob,
  openJob,
  assign,
  isInJob,
  activeProcessCount,
  terminateJob,
  duplicateInto,
  closeRemoteHandle,
  listProcesses,
};
