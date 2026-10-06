// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md

//go:build windows

// owb-sandbox：Windows 上给 AI 跑的命令套一层系统隔离（macOS 那边是 sandbox-exec，见 src/platform/sandbox.js）。
//
// 原理是 Windows 自带的「完整性级别」：
//   - run：把自己的令牌复制一份、降到「低」，用它起命令。低级别进程写不了普通（中）级别的文件、注册表和进程，
//     所以应用目录、账本、用户主目录里会自动执行的文件、OWB 自己的进程，它都碰不到。
//   - label：给几处目录打标记。Key 和账本所在的文件标成「低级别不许读」；工作区标成「低级别能写」。
//
// 只用标准库，交叉编译：GOOS=windows GOARCH=amd64/arm64（scripts/build-sandbox.js）。
package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var (
	advapi32 = syscall.NewLazyDLL("advapi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procDuplicateTokenEx    = advapi32.NewProc("DuplicateTokenEx")
	procSetTokenInformation = advapi32.NewProc("SetTokenInformation")
	procStringSDToSD        = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	procSDToStringSD        = advapi32.NewProc("ConvertSecurityDescriptorToStringSecurityDescriptorW")
	procSetFileSecurity     = advapi32.NewProc("SetFileSecurityW")
	procGetFileSecurity     = advapi32.NewProc("GetFileSecurityW")
	procCreateJobObject     = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJob   = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJob  = kernel32.NewProc("AssignProcessToJobObject")
	procResumeThread        = kernel32.NewProc("ResumeThread")
	procGetLengthSid        = advapi32.NewProc("GetLengthSid")
)

const (
	tokenIntegrityLevel      = 25
	seGroupIntegrity         = 0x20
	tokenPrimary             = 1
	securityImpersonation    = 2
	maximumAllowed           = 0x02000000
	labelSecurityInformation = 0x10
	createSuspended          = 0x00000004
	createNoWindow           = 0x08000000
	createUnicodeEnvironment = 0x00000400
	jobObjectExtendedLimit   = 9
	jobLimitKillOnJobClose   = 0x2000
	lowRID                   = 0x1000
	lowSID                   = "S-1-16-4096"
	exitHelperFailed         = 125 // 小助手自己没跑起来（命令根本没起）；跟命令自己的退出码分开
	exitDenied               = 3   // 探针：被拒了
	exitOtherError           = 2   // 探针：别的错
	exitNotLow               = 4   // 探针：不是低级别
)

// 几种标记。ME = 中，LW = 低；NR = 低级别不许读，NW = 不许写
// OICI：文件和子目录都继承；OIIONP：只给这一层新建的文件，目录本身和更深的都不带
const (
	sddlSecretDir  = "S:(ML;OICI;NRNW;;;ME)"
	sddlSecretFile = "S:(ML;;NRNW;;;ME)"
	sddlDataRoot   = "S:(ML;OIIONP;NRNW;;;ME)"
	sddlWorkDir    = "S:(ML;OICI;NW;;;LW)"
	sddlWorkFile   = "S:(ML;;NW;;;LW)"
)

type sidAndAttributes struct {
	Sid        *syscall.SID
	Attributes uint32
}

type tokenMandatoryLabel struct {
	Label sidAndAttributes
}

type ioCounters struct {
	ReadOperationCount, WriteOperationCount, OtherOperationCount uint64
	ReadTransferCount, WriteTransferCount, OtherTransferCount    uint64
}

type basicLimit struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type extendedLimit struct {
	BasicLimitInformation basicLimit
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

func fail(format string, a ...any) int {
	fmt.Fprintf(os.Stderr, "owb-sandbox: "+format+"\n", a...)
	return exitHelperFailed
}

func main() {
	if len(os.Args) < 2 {
		os.Exit(fail("用法：run -- <命令行> | label <种类> <路径>… | il | try-read <文件> | try-write <目录>"))
	}
	switch os.Args[1] {
	case "run":
		os.Exit(run())
	case "label":
		os.Exit(label(os.Args[2:]))
	case "il":
		os.Exit(il())
	case "try-read":
		os.Exit(tryRead(os.Args[2:]))
	case "try-write":
		os.Exit(tryWrite(os.Args[2:]))
	}
	os.Exit(fail("不认识的子命令 %q", os.Args[1]))
}

// ---- run ----

// rawTail 取自己命令行里 run -- 后面那一截，原样交给 CreateProcess。
// 不能用 os.Args 拼回去：cmd /s /c 那层引号、带空格的路径，拆开再拼就不是原来那条了
func rawTail() (string, error) {
	line := utf16PtrToString(syscall.GetCommandLine())
	rest := line
	// 跳过 argv0：带引号就找下一个引号，不带就找第一个空白
	if strings.HasPrefix(rest, `"`) {
		i := strings.Index(rest[1:], `"`)
		if i < 0 {
			return "", errors.New("命令行引号没配对")
		}
		rest = rest[i+2:]
	} else if i := strings.IndexAny(rest, " \t"); i >= 0 {
		rest = rest[i:]
	} else {
		rest = ""
	}
	rest = strings.TrimLeft(rest, " \t")
	if !strings.HasPrefix(rest, "run -- ") {
		return "", errors.New("要写成 run -- <命令行>")
	}
	tail := rest[len("run -- "):]
	if strings.TrimSpace(tail) == "" {
		return "", errors.New("run -- 后面是空的")
	}
	return tail, nil
}

func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	var s []uint16
	for ptr := unsafe.Pointer(p); ; ptr = unsafe.Add(ptr, 2) {
		c := *(*uint16)(ptr)
		if c == 0 {
			break
		}
		s = append(s, c)
	}
	return syscall.UTF16ToString(s)
}

// lowToken 复制自己的令牌，降到低完整性级别
func lowToken() (syscall.Token, error) {
	var self syscall.Token
	if err := syscall.OpenProcessToken(syscall.Handle(currentProcess()), syscall.TOKEN_DUPLICATE|syscall.TOKEN_QUERY|syscall.TOKEN_ASSIGN_PRIMARY|syscall.TOKEN_ADJUST_DEFAULT, &self); err != nil {
		return 0, fmt.Errorf("打不开自己的令牌：%v", err)
	}
	defer self.Close()
	var dup syscall.Token
	r, _, e := procDuplicateTokenEx.Call(uintptr(self), maximumAllowed, 0, securityImpersonation, tokenPrimary, uintptr(unsafe.Pointer(&dup)))
	if r == 0 {
		return 0, fmt.Errorf("复制令牌失败：%v", e)
	}
	sid, err := syscall.StringToSid(lowSID)
	if err != nil {
		dup.Close()
		return 0, fmt.Errorf("低级别 SID 转不出来：%v", err)
	}
	tml := tokenMandatoryLabel{Label: sidAndAttributes{Sid: sid, Attributes: seGroupIntegrity}}
	size := uint32(unsafe.Sizeof(tml)) + sidLen(sid)
	r, _, e = procSetTokenInformation.Call(uintptr(dup), tokenIntegrityLevel, uintptr(unsafe.Pointer(&tml)), uintptr(size))
	if r == 0 {
		dup.Close()
		return 0, fmt.Errorf("令牌降级失败：%v", e)
	}
	return dup, nil
}

func currentProcess() uintptr {
	h, _ := syscall.GetCurrentProcess()
	return uintptr(h)
}

func sidLen(s *syscall.SID) uint32 {
	n, _, _ := procGetLengthSid.Call(uintptr(unsafe.Pointer(s)))
	return uint32(n)
}

// killJob：小助手一退（正常退、被 TerminateProcess、被 taskkill），整棵子进程树跟着收
func killJob() (syscall.Handle, error) {
	h, _, e := procCreateJobObject.Call(0, 0)
	if h == 0 {
		return 0, fmt.Errorf("建作业对象失败：%v", e)
	}
	var info extendedLimit
	info.BasicLimitInformation.LimitFlags = jobLimitKillOnJobClose
	r, _, e := procSetInformationJob.Call(h, jobObjectExtendedLimit, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if r == 0 {
		syscall.CloseHandle(syscall.Handle(h))
		return 0, fmt.Errorf("设置作业对象失败：%v", e)
	}
	return syscall.Handle(h), nil
}

func run() int {
	tail, err := rawTail()
	if err != nil {
		return fail("%v", err)
	}
	tok, err := lowToken()
	if err != nil {
		return fail("%v", err)
	}
	defer tok.Close()
	job, err := killJob()
	if err != nil {
		return fail("%v", err)
	}
	// 不关 job：进程退出时系统替我们关，关的那一刻收掉整棵树

	si := syscall.StartupInfo{Flags: syscall.STARTF_USESTDHANDLES}
	si.Cb = uint32(unsafe.Sizeof(si))
	std := []*syscall.Handle{&si.StdInput, &si.StdOutput, &si.StdErr}
	for i, which := range []int{syscall.STD_INPUT_HANDLE, syscall.STD_OUTPUT_HANDLE, syscall.STD_ERROR_HANDLE} {
		h, err := syscall.GetStdHandle(which)
		if err != nil || h == syscall.InvalidHandle {
			continue
		}
		_ = syscall.SetHandleInformation(h, syscall.HANDLE_FLAG_INHERIT, syscall.HANDLE_FLAG_INHERIT)
		*std[i] = h
	}
	cmd, err := syscall.UTF16FromString(tail)
	if err != nil {
		return fail("命令行里有 NUL")
	}
	var pi syscall.ProcessInformation
	// 先挂起，进了作业对象再放它跑：不然它抢在 Assign 之前起的子进程就不在树里
	// 没有控制台窗口：服务进程本来就没有屏幕上的黑框，命令的输出走上面那三根管子
	err = syscall.CreateProcessAsUser(tok, nil, &cmd[0], nil, nil, true, createSuspended|createNoWindow|createUnicodeEnvironment, nil, nil, &si, &pi)
	if err != nil {
		return fail("起不来命令：%v", err)
	}
	defer syscall.CloseHandle(pi.Process)
	if r, _, e := procAssignProcessToJob.Call(uintptr(job), uintptr(pi.Process)); r == 0 {
		syscall.TerminateProcess(pi.Process, exitHelperFailed)
		syscall.CloseHandle(pi.Thread)
		return fail("放不进作业对象：%v", e)
	}
	procResumeThread.Call(uintptr(pi.Thread))
	syscall.CloseHandle(pi.Thread)
	if _, err := syscall.WaitForSingleObject(pi.Process, syscall.INFINITE); err != nil {
		return fail("等命令结束失败：%v", err)
	}
	var code uint32
	if err := syscall.GetExitCodeProcess(pi.Process, &code); err != nil {
		return fail("拿不到退出码：%v", err)
	}
	return int(code)
}

// ---- label ----

// label <种类> <路径> [<种类> <路径> …]
//
//	workspace  工作区：低级别能写。目录本身已经是这个标记就跳过（新建的文件会继承），否则整棵树过一遍
//	secret     Key、账本：低级别读写都不行。目录整棵树每次都过（搬进来的文件不会自己继承）
//	data-root  数据根本身：只给以后直接建在这一层的文件带上「不许读」（config.json 是先写临时文件再改名的）
//
// 联接点、符号链接一律不跟、不标：工作区里那个指向应用 node_modules 的联接点，跟过去就把应用目录放开了
func label(args []string) int {
	if len(args) == 0 || len(args)%2 != 0 {
		return fail("label 要成对的 <种类> <路径>")
	}
	for i := 0; i < len(args); i += 2 {
		kind, p := args[i], args[i+1]
		if !filepath.IsAbs(p) {
			return fail("不是绝对路径：%s", p)
		}
		var err error
		switch kind {
		case "workspace":
			err = labelWorkspace(p)
		case "secret":
			err = labelSecret(p)
		case "data-root":
			err = setLabel(p, sddlDataRoot)
		default:
			return fail("不认识的种类 %q", kind)
		}
		if err != nil {
			return fail("%s %s：%v", kind, p, err)
		}
	}
	return 0
}

func labelWorkspace(root string) error {
	if cur, err := getLabel(root); err == nil && sameLabel(cur, sddlWorkDir) {
		return nil
	}
	// 根目录最后标：中途失败（文件太多被超时掐了）下回还会从头再过一遍
	if err := walk(root, sddlWorkDir, sddlWorkFile, false); err != nil {
		return err
	}
	return setLabel(root, sddlWorkDir)
}

func labelSecret(p string) error {
	st, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !st.Mode().IsDir() {
		if !st.Mode().IsRegular() {
			return nil
		}
		return setLabel(p, sddlSecretFile)
	}
	if err := setLabel(p, sddlSecretDir); err != nil {
		return err
	}
	return walk(p, sddlSecretDir, sddlSecretFile, true)
}

// walk 给 root 底下的目录、文件逐个打标记（root 自己不管）。strict：标不上就算失败；否则跳过标不上的
func walk(root, dirSDDL, fileSDDL string, strict bool) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if strict {
				return err
			}
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if p == root {
			return nil
		}
		t := d.Type()
		if t&(fs.ModeSymlink|fs.ModeIrregular) != 0 {
			return nil
		}
		s := fileSDDL
		if d.IsDir() {
			s = dirSDDL
		} else if !t.IsRegular() {
			return nil
		}
		if e := setLabel(p, s); e != nil && strict {
			return e
		}
		return nil
	})
}

// setLabel 只改这一个对象的标记，不往下传（SetFileSecurity 不做继承传播）
func setLabel(p, sddl string) error {
	var sd uintptr
	s, _ := syscall.UTF16PtrFromString(sddl)
	r, _, e := procStringSDToSD.Call(uintptr(unsafe.Pointer(s)), 1, uintptr(unsafe.Pointer(&sd)), 0)
	if r == 0 {
		return fmt.Errorf("标记写法不对：%v", e)
	}
	defer syscall.LocalFree(syscall.Handle(sd))
	name, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		return err
	}
	r, _, e = procSetFileSecurity.Call(uintptr(unsafe.Pointer(name)), labelSecurityInformation, sd)
	if r == 0 {
		return e
	}
	return nil
}

func getLabel(p string) (string, error) {
	name, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		return "", err
	}
	var need uint32
	procGetFileSecurity.Call(uintptr(unsafe.Pointer(name)), labelSecurityInformation, 0, 0, uintptr(unsafe.Pointer(&need)))
	if need == 0 {
		return "", errors.New("读不到标记")
	}
	buf := make([]byte, need)
	r, _, e := procGetFileSecurity.Call(uintptr(unsafe.Pointer(name)), labelSecurityInformation, uintptr(unsafe.Pointer(&buf[0])), uintptr(need), uintptr(unsafe.Pointer(&need)))
	if r == 0 {
		return "", e
	}
	var str *uint16
	r, _, e = procSDToStringSD.Call(uintptr(unsafe.Pointer(&buf[0])), 1, labelSecurityInformation, uintptr(unsafe.Pointer(&str)), 0)
	if r == 0 {
		return "", e
	}
	defer syscall.LocalFree(syscall.Handle(unsafe.Pointer(str)))
	return utf16PtrToString(str), nil
}

// sameLabel：系统吐回来的写法会把 LW 写成 S-1-16-4096 之类，按缩写和 SID 两种都认
func sameLabel(got, want string) bool {
	norm := func(s string) string {
		s = strings.ToUpper(strings.ReplaceAll(s, " ", ""))
		s = strings.ReplaceAll(s, "S-1-16-4096", "LW")
		s = strings.ReplaceAll(s, "S-1-16-8192", "ME")
		return s
	}
	return strings.Contains(norm(got), strings.TrimPrefix(norm(want), "S:"))
}

// ---- 探针（预检用） ----

func il() int {
	var tok syscall.Token
	if err := syscall.OpenProcessToken(syscall.Handle(currentProcess()), syscall.TOKEN_QUERY, &tok); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitOtherError
	}
	defer tok.Close()
	var need uint32
	syscall.GetTokenInformation(tok, tokenIntegrityLevel, nil, 0, &need)
	if need == 0 {
		return exitOtherError
	}
	buf := make([]byte, need)
	if err := syscall.GetTokenInformation(tok, tokenIntegrityLevel, &buf[0], need, &need); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return exitOtherError
	}
	tml := (*tokenMandatoryLabel)(unsafe.Pointer(&buf[0]))
	sid, err := tml.Label.Sid.String()
	if err != nil {
		return exitOtherError
	}
	fmt.Println(sid)
	if sid == lowSID {
		return 0
	}
	return exitNotLow
}

func probeCode(err error) int {
	if err == nil {
		return 0
	}
	fmt.Fprintln(os.Stderr, err)
	if errors.Is(err, fs.ErrPermission) {
		return exitDenied
	}
	return exitOtherError
}

func tryRead(args []string) int {
	if len(args) != 1 {
		return exitOtherError
	}
	f, err := os.Open(args[0])
	if err == nil {
		_, err = f.Read(make([]byte, 1))
		f.Close()
		if errors.Is(err, io.EOF) {
			err = nil
		}
	}
	return probeCode(err)
}

func tryWrite(args []string) int {
	if len(args) != 1 {
		return exitOtherError
	}
	p := filepath.Join(args[0], fmt.Sprintf(".owb-sandbox-probe-%d", os.Getpid()))
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err == nil {
		f.Close()
		err = os.Remove(p)
	}
	return probeCode(err)
}
