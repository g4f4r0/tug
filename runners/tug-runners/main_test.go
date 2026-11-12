package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
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
	ps         string
	logs       map[string]string
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
	shared.containers, shared.ps, shared.logs = map[string]chan struct{}{}, "", map[string]string{}
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
		c := f.containers[args[1]]
		f.mu.Unlock()
		if c != nil {
			<-c
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
		return []byte(f.logs[args[1]]), nil
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

func TestNormalizePEMRestoresLineBreaks(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encoded := string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	flat := strings.ReplaceAll(encoded, "\n", " ")
	block, _ := pem.Decode([]byte(normalizePEM(flat)))
	if block == nil {
		t.Fatal("normalized key does not decode")
	}
	if _, err := x509.ParsePKCS1PrivateKey(block.Bytes); err != nil {
		t.Fatal(err)
	}
}

func TestDiscoverServesOnlyAllowedPrivateScopes(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	type account struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	}
	type inst struct {
		ID      int64   `json:"id"`
		Account account `json:"account"`
	}
	// Page 1 is full, so the allowed user on page 2 is found only by paginating.
	page1 := []inst{{ID: 1, Account: account{"HelloGafaro", "Organization"}}, {ID: 2, Account: account{"public-org", "Organization"}}}
	for i := len(page1); i < 100; i++ {
		page1 = append(page1, inst{ID: int64(100 + i), Account: account{fmt.Sprintf("stranger-%d", i), "User"}})
	}
	page2 := []inst{{ID: 3, Account: account{"g4f4r0", "User"}}}
	var tokens []string
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case path == "/app/installations" && r.URL.Query().Get("page") == "1":
			_ = json.NewEncoder(w).Encode(page1)
		case path == "/app/installations":
			_ = json.NewEncoder(w).Encode(page2)
		case strings.HasSuffix(path, "/access_tokens"):
			mu.Lock()
			tokens = append(tokens, path)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"token": "t"})
		case path == "/orgs/HelloGafaro/actions/runner-groups/1":
			_ = json.NewEncoder(w).Encode(map[string]bool{"allows_public_repositories": false})
		case path == "/orgs/public-org/actions/runner-groups/1":
			_ = json.NewEncoder(w).Encode(map[string]bool{"allows_public_repositories": true})
		case path == "/installation/repositories":
			_ = json.NewEncoder(w).Encode(map[string]any{"repositories": []map[string]any{
				{"full_name": "g4f4r0/private", "private": true},
				{"full_name": "g4f4r0/public", "private": false},
				{"full_name": "g4f4r0/old", "private": true, "archived": true},
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	previous := apiBase
	apiBase = server.URL
	defer func() { apiBase = previous }()

	c := &config{appID: "1", signer: key, owners: []string{"hellogafaro", "public-org", "g4f4r0"}}
	scopes, err := c.discover(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var urls []string
	for _, sc := range scopes {
		urls = append(urls, sc.url)
	}
	if want := []string{"https://github.com/HelloGafaro", "https://github.com/g4f4r0/private"}; !slices.Equal(urls, want) {
		t.Fatalf("want %v, got %v", want, urls)
	}
	// Never even signs in to an installation outside TUG_ACCOUNTS.
	if len(tokens) != 3 {
		t.Fatalf("want tokens for the 3 allowed installations only, got %v", tokens)
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
