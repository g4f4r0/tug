package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/actions/scaleset"
)

// fakeDocker runs containers as channels: `run` creates one, `wait` blocks until it is stopped, `rm` stops it.
type fakeDocker struct {
	mu         sync.Mutex
	containers map[string]chan struct{}
	stopped    map[string]bool
	ps         string
	logs       map[string]string
	logArgs    [][]string
}

// shared is installed once, so a runner's watch left over from an earlier test never races a swap of docker.
var shared = &fakeDocker{}

func TestMain(m *testing.M) {
	docker = shared.run
	m.Run()
}

// newFakeDocker gives a test an empty Docker; containers of earlier tests stay stopped forever.
func newFakeDocker(*testing.T) *fakeDocker {
	shared.mu.Lock()
	defer shared.mu.Unlock()
	shared.containers, shared.stopped, shared.ps, shared.logs, shared.logArgs = map[string]chan struct{}{}, map[string]bool{}, "", map[string]string{}, nil
	return shared
}

func (f *fakeDocker) add(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers[name] = make(chan struct{})
}

func (f *fakeDocker) stop(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.containers[name]; ok {
		close(c)
		delete(f.containers, name)
		f.stopped[name] = true
	}
}

func (f *fakeDocker) running() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.containers)
}

func (f *fakeDocker) run(env []string, args ...string) ([]byte, error) {
	switch args[0] {
	case "run":
		f.add(args[slices.Index(args, "--name")+1])
	case "wait":
		f.mu.Lock()
		c, stopped := f.containers[args[1]], f.stopped[args[1]]
		f.mu.Unlock()
		switch {
		case c != nil:
			<-c
		case !stopped:
			// A container of an earlier test, whose watch got here after the reset: it never exits, so its
			// pool never frees a slot into this test's Docker.
			select {}
		}
	case "rm":
		f.stop(args[2])
	case "ps":
		f.mu.Lock()
		defer f.mu.Unlock()
		return []byte(f.ps), nil
	case "logs":
		f.mu.Lock()
		defer f.mu.Unlock()
		f.logArgs = append(f.logArgs, args)
		return []byte(f.logs[args[len(args)-1]]), nil
	}
	return nil, nil
}

type fakeAPI struct {
	mu      sync.Mutex
	next    int
	removed []int64
}

func (a *fakeAPI) GenerateJitRunnerConfig(_ context.Context, setting *scaleset.RunnerScaleSetJitRunnerSetting, _ int) (*scaleset.RunnerScaleSetJitRunnerConfig, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.next++
	return &scaleset.RunnerScaleSetJitRunnerConfig{Runner: &scaleset.RunnerReference{ID: a.next, Name: setting.Name}, EncodedJITConfig: "jit"}, nil
}

func (a *fakeAPI) RemoveRunner(_ context.Context, id int64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.removed = append(a.removed, id)
	return nil
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func testPool(max int) *pool {
	return &pool{cfg: &config{max: max, cpus: "1", memory: "1g", pids: "100", network: "tug", keys: "k", image: "img"}, scalers: map[string]*scaler{}, adopted: map[string][]string{}}
}

func (p *pool) addScaler(url string) *scaler {
	s := &scaler{pool: p, scope: scope{url: url}, client: &fakeAPI{}, listening: true, runners: map[string]*runner{}}
	p.mu.Lock()
	p.scalers[url] = s
	p.mu.Unlock()
	return s
}

func (s *scaler) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.runners)
}

func (s *scaler) want(n int) {
	s.mu.Lock()
	s.desired = n
	s.mu.Unlock()
	s.fill(context.Background())
}

func (s *scaler) names() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var names []string
	for name := range s.runners {
		names = append(names, name)
	}
	return names
}

func TestPoolCapIsSharedAndFreedSlotsGoToWaitingScopes(t *testing.T) {
	d := newFakeDocker(t)
	p := testPool(3)
	a, b := p.addScaler("https://github.com/a"), p.addScaler("https://github.com/b")

	a.want(2)
	b.want(2)
	if a.count() != 2 || b.count() != 1 || d.running() != 3 {
		t.Fatalf("want 2 + 1 runners under a cap of 3, got %d + %d (%d containers)", a.count(), b.count(), d.running())
	}

	// One of a's jobs ends; b's waiting job takes the slot.
	a.mu.Lock()
	a.desired = 1
	a.mu.Unlock()
	d.stop(a.names()[0])
	eventually(t, "b's second runner", func() bool { return b.count() == 2 })
	if a.count() != 1 || p.free() != 0 {
		t.Fatalf("want a 1, free 0; got a %d, free %d", a.count(), p.free())
	}
}

func TestEveryScopeReportsTheWholePoolEvenWhenFull(t *testing.T) {
	newFakeDocker(t)
	p := testPool(2)
	p.addScaler("https://github.com/a").want(2)
	if p.free() != 0 {
		t.Fatalf("want a full pool, got %d free", p.free())
	}
	if got := p.listenerConfig(7); got.MaxRunners != 2 || got.ScaleSetID != 7 {
		t.Fatalf("a waiting scope must report the whole pool of 2, got %+v", got)
	}
}

func TestReapRemovesOnlyOldIdleRunnersPastDemand(t *testing.T) {
	d := newFakeDocker(t)
	p := testPool(4)
	s := p.addScaler("https://github.com/a")
	s.want(3)
	names := s.names()
	s.mu.Lock()
	s.runners[names[0]].busy = true
	s.runners[names[0]].started = time.Now().Add(-time.Hour)
	s.runners[names[1]].started = time.Now().Add(-time.Hour)
	s.desired = 1
	s.mu.Unlock()

	s.reap(context.Background())
	// The busy one stays, the old idle one goes, and the new idle one stays: it may be about to take a job.
	eventually(t, "the old idle runner to go", func() bool { return s.count() == 2 })
	if !slices.Contains(s.names(), names[0]) || !slices.Contains(s.names(), names[2]) || d.running() != 2 {
		t.Fatalf("wrong runners left: %v", s.names())
	}
	if removed := s.client.(*fakeAPI).removed; len(removed) != 1 {
		t.Fatalf("want one runner deregistered, got %v", removed)
	}
}

func TestAdoptedJobsKeepTheirSlotUntilTheyExit(t *testing.T) {
	d := newFakeDocker(t)
	d.mu.Lock()
	d.ps = "tug-busy https://github.com/gone\ntug-idle https://github.com/gone\ntug-mine https://github.com/a\n"
	d.logs = map[string]string{"tug-busy": "Running job: test", "tug-mine": "Running job: review"}
	d.mu.Unlock()
	for _, name := range []string{"tug-busy", "tug-idle", "tug-mine"} {
		d.add(name)
	}
	p := testPool(2)
	p.adopt()
	if p.free() != 0 || d.running() != 2 {
		t.Fatalf("want both busy containers adopted and the idle one removed; free %d, containers %d", p.free(), d.running())
	}
	d.mu.Lock()
	logArgs := d.logArgs
	d.mu.Unlock()
	if len(logArgs) != 3 || !slices.Equal(logArgs[0], []string{"logs", "--tail", "100", "tug-busy"}) {
		t.Fatalf("want each container's last 100 log lines read, got %v", logArgs)
	}

	// A scope that is served counts its adopted runner, so it starts no second one for the same job.
	s := p.addScaler("https://github.com/a")
	p.mu.Lock()
	for _, name := range p.adopted[s.scope.url] {
		s.runners[name] = &runner{busy: true}
	}
	p.mu.Unlock()
	s.want(1)
	if s.count() != 1 || d.running() != 2 {
		t.Fatalf("want the adopted runner only; got %d runners, %d containers", s.count(), d.running())
	}

	// A scope no longer served still frees its slot when the job ends.
	d.stop("tug-busy")
	eventually(t, "the unserved scope's slot", func() bool { return p.free() == 1 })
	s.mu.Lock()
	s.desired = 0
	s.mu.Unlock()
	d.stop("tug-mine")
	eventually(t, "the served scope's slot", func() bool { return p.free() == 2 && s.count() == 0 })
}

func TestConfigNeedsTheTokenAndAccounts(t *testing.T) {
	for _, tc := range []struct{ token, accounts, err string }{
		{"ghp_x", "me,my-org", ""},
		{"", "me", "TUG_GITHUB_TOKEN and TUG_ACCOUNTS are required"},
		{"ghp_x", " , ", "TUG_GITHUB_TOKEN and TUG_ACCOUNTS are required"},
	} {
		t.Setenv("TUG_GITHUB_TOKEN", tc.token)
		t.Setenv("TUG_ACCOUNTS", tc.accounts)
		c, err := loadConfig()
		if tc.err == "" && (err != nil || c.token != "ghp_x" || !slices.Equal(c.owners, []string{"me", "my-org"})) {
			t.Fatalf("want the token and both accounts, got %+v, %v", c, err)
		}
		if tc.err != "" && (err == nil || err.Error() != tc.err) {
			t.Fatalf("want %q, got %v", tc.err, err)
		}
	}
}

func TestMissingScopesNamesOnlyAClassicTokensGaps(t *testing.T) {
	for _, tc := range []struct {
		header  http.Header
		missing []string
	}{
		{http.Header{"X-Oauth-Scopes": {"admin:org, gist, repo, workflow"}}, nil},
		{http.Header{"X-Oauth-Scopes": {"gist, read:org, repo, workflow"}}, []string{"admin:org"}},
		{http.Header{"X-Oauth-Scopes": {""}}, []string{"repo", "admin:org"}},
		// A fine-grained token has no scopes header: nothing to check.
		{http.Header{}, nil},
	} {
		if got := missingScopes(tc.header); !slices.Equal(got, tc.missing) {
			t.Fatalf("%v: want %v, got %v", tc.header, tc.missing, got)
		}
	}
}

// lockedBuffer collects log lines that other tests' goroutines may write too.
type lockedBuffer struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestDiscoverServesOnlyAllowedPrivateScopes(t *testing.T) {
	type repo struct {
		FullName string `json:"full_name"`
		Private  bool   `json:"private"`
		Archived bool   `json:"archived,omitempty"`
	}
	// Page 1 is full, so the private repository on page 2 is found only by paginating.
	page1 := []repo{{"octocat/private", true, false}, {"octocat/public", false, false}, {"octocat/old", true, true}}
	for i := len(page1); i < 100; i++ {
		page1 = append(page1, repo{fmt.Sprintf("octocat/public-%d", i), false, false})
	}
	page2 := []repo{{"octocat/second", true, false}}
	gone := map[string]bool{}
	failing := false
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer ghp_x" {
			http.Error(w, "Bad credentials", http.StatusUnauthorized)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		path, query := r.URL.Path, r.URL.Query()
		switch {
		case gone[path]:
			http.NotFound(w, r)
		case failing && path == "/user/repos" && query.Get("page") == "2":
			http.Error(w, "Server Error", http.StatusInternalServerError)
		case path == "/user":
			_ = json.NewEncoder(w).Encode(map[string]string{"login": "OctoCat"})
		case path == "/user/repos" && (query.Get("affiliation") != "owner" || query.Get("visibility") != "private"):
			http.Error(w, "only the user's own private repositories", http.StatusBadRequest)
		case path == "/user/repos" && query.Get("page") == "1":
			_ = json.NewEncoder(w).Encode(page1)
		case path == "/user/repos" && query.Get("page") == "2":
			_ = json.NewEncoder(w).Encode(page2)
		case path == "/users/acme":
			_ = json.NewEncoder(w).Encode(map[string]string{"login": "Acme", "type": "Organization"})
		case path == "/users/public-org", path == "/users/locked-org":
			_ = json.NewEncoder(w).Encode(map[string]string{"login": path[len("/users/"):], "type": "Organization"})
		case path == "/users/someone":
			_ = json.NewEncoder(w).Encode(map[string]string{"login": "someone", "type": "User"})
		case path == "/orgs/Acme/actions/runner-groups/1":
			_ = json.NewEncoder(w).Encode(map[string]bool{"allows_public_repositories": false})
		case path == "/orgs/public-org/actions/runner-groups/1":
			_ = json.NewEncoder(w).Encode(map[string]bool{"allows_public_repositories": true})
		case path == "/orgs/locked-org/actions/runner-groups/1":
			http.Error(w, "Must have admin rights to Repository.", http.StatusForbidden)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	previous := apiBase
	apiBase = server.URL
	defer func() { apiBase = previous }()
	logs := &lockedBuffer{}
	previousLog := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	defer slog.SetDefault(previousLog)

	c := &config{token: "ghp_x", owners: []string{"acme", "public-org", "locked-org", "someone", "octocat"}}
	urls := func() []string {
		t.Helper()
		scopes, err := c.discover(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		var urls []string
		for _, sc := range scopes {
			urls = append(urls, sc.url)
		}
		return urls
	}
	if want, got := []string{"https://github.com/Acme", "https://github.com/octocat/private", "https://github.com/octocat/second"}, urls(); !slices.Equal(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for _, line := range []string{
		`msg="Skipping an organization whose runners the token can't manage: it needs an owner's token with admin:org" account=locked-org`,
		`msg="Skipping an organization whose Default runner group allows public repositories" account=public-org`,
		`msg="Skipping another user's account: the token serves only its own user's repositories" account=someone`,
	} {
		if !strings.Contains(logs.String(), line) {
			t.Fatalf("want a log line with %s, got:\n%s", line, logs)
		}
	}

	// The next round stops serving a repository and an organization that are gone.
	mu.Lock()
	page2 = nil
	gone["/users/acme"] = true
	mu.Unlock()
	if want, got := []string{"https://github.com/octocat/private"}, urls(); !slices.Equal(got, want) {
		t.Fatalf("want %v, got %v", want, got)
	}

	// GitHub failing partway fails the round, rather than serving a partial list.
	mu.Lock()
	failing = true
	mu.Unlock()
	if _, err := c.discover(context.Background()); err == nil || refused(err) {
		t.Fatalf("want a failed round, got %v", err)
	}

	// A token GitHub refuses finds nothing to serve, so the current scopes stay until the next round.
	c.token = "revoked"
	if _, err := c.discover(context.Background()); !refused(err) {
		t.Fatalf("want a refused sign-in, got %v", err)
	}
}

func TestShareSplitsTheHostEvenly(t *testing.T) {
	if cpus, memory := share(16, 32<<30, 6); cpus != "2.67" || memory != fmt.Sprint(int64(32<<30)/6) {
		t.Fatalf("got %s CPUs, %s bytes", cpus, memory)
	}
	// Never below one CPU and 1 GiB, however many containers.
	if cpus, memory := share(2, 2<<30, 8); cpus != "1.00" || memory != fmt.Sprint(int64(1<<30)) {
		t.Fatalf("got %s CPUs, %s bytes", cpus, memory)
	}
}

func TestDockerTimesOutEveryCommandButWait(t *testing.T) {
	script := t.TempDir() + "/docker"
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexec sleep 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	previousBin, previousTimeout := dockerBin, dockerTimeout
	dockerBin, dockerTimeout = script, 50*time.Millisecond
	defer func() { dockerBin, dockerTimeout = previousBin, previousTimeout }()

	started := time.Now()
	if _, err := runDocker(nil, "ps"); err == nil || time.Since(started) > 900*time.Millisecond {
		t.Fatalf("want ps stopped at its timeout, got %v after %s", err, time.Since(started))
	}
	started = time.Now()
	if _, err := runDocker(nil, "wait", "tug-1"); err != nil || time.Since(started) < time.Second {
		t.Fatalf("want wait to run to its end, got %v after %s", err, time.Since(started))
	}
}

func TestCleanupServicePullsTheRunnerImageAgain(t *testing.T) {
	unit, err := os.ReadFile("../tug-cleanup.service")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(unit), "docker pull --quiet "+runnerImage+"\n") {
		t.Fatalf("tug-cleanup.service does not pull %s again", runnerImage)
	}
}
