// tug-runners starts one single-use GitHub Actions runner, in Docker on the network tug, for each job queued for the
// label tug in every account that has the Tug runners GitHub App installed and is listed in TUG_OWNERS. It never runs
// more than TUG_MAX_RUNNERS at once across all of them. Organizations get one runner scale set each, in their Default
// runner group, which must not allow public repositories; personal accounts get one per private repository the
// installation includes. No secret enters a container: it gets only its single-use runner config and TUG_KEYS.
package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/actions/scaleset"
	"github.com/actions/scaleset/listener"
)

const (
	defaultRunnerGroup = 1
	discoverEvery      = 5 * time.Minute
	idleLimit          = 10 * time.Minute
	containerLabel     = "tug.scope"
)

type config struct {
	appID   string
	key     string
	signer  *rsa.PrivateKey
	owners  []string
	max     int
	label   string
	image   string
	network string
	keys    string
	cpus    string
	memory  string
	pids    string
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func loadConfig() (*config, error) {
	c := &config{
		appID:   env("TUG_APP_ID", ""),
		key:     normalizePEM(os.Getenv("TUG_APP_PRIVATE_KEY")),
		label:   env("TUG_LABEL", "tug"),
		image:   env("TUG_IMAGE", "ghcr.io/actions/actions-runner:latest"),
		network: env("TUG_NETWORK", "tug"),
		keys:    env("TUG_KEYS", "http://172.30.99.1:8787"),
		cpus:    env("TUG_CPUS", "4"),
		memory:  env("TUG_MEMORY", "6g"),
		pids:    env("TUG_PIDS", "4096"),
	}
	for _, owner := range strings.Split(os.Getenv("TUG_OWNERS"), ",") {
		if owner = strings.ToLower(strings.TrimSpace(owner)); owner != "" {
			c.owners = append(c.owners, owner)
		}
	}
	max, err := strconv.Atoi(env("TUG_MAX_RUNNERS", "4"))
	if err != nil || max < 1 {
		return nil, fmt.Errorf("TUG_MAX_RUNNERS must be a positive number")
	}
	c.max = max
	if c.appID == "" || c.key == "" || len(c.owners) == 0 {
		return nil, errors.New("TUG_APP_ID, TUG_APP_PRIVATE_KEY and TUG_OWNERS are required")
	}
	block, _ := pem.Decode([]byte(c.key))
	if block == nil {
		return nil, errors.New("TUG_APP_PRIVATE_KEY is not a PEM key")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		c.signer = key
	} else if parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		key, ok := parsed.(*rsa.PrivateKey)
		if !ok {
			return nil, errors.New("TUG_APP_PRIVATE_KEY is not an RSA key")
		}
		c.signer = key
	} else {
		return nil, fmt.Errorf("TUG_APP_PRIVATE_KEY: %w", err)
	}
	return c, nil
}

// normalizePEM rebuilds a PEM key whose line breaks were lost when it was pasted into a one-line field.
func normalizePEM(key string) string {
	key = strings.TrimSpace(key)
	begin := strings.Index(key, "-----BEGIN ")
	if begin < 0 {
		return key
	}
	rest := key[begin+len("-----BEGIN "):]
	typeEnd := strings.Index(rest, "-----")
	if typeEnd < 0 {
		return key
	}
	kind := rest[:typeEnd]
	end := strings.Index(rest, "-----END "+kind+"-----")
	if end < 0 {
		return key
	}
	body := strings.Join(strings.Fields(rest[typeEnd+len("-----"):end]), "")
	var lines []string
	for len(body) > 64 {
		lines, body = append(lines, body[:64]), body[64:]
	}
	lines = append(lines, body)
	return "-----BEGIN " + kind + "-----\n" + strings.Join(lines, "\n") + "\n-----END " + kind + "-----\n"
}

// A scope is where one runner scale set lives: an organization, or a personal account's repository.
type scope struct {
	url          string
	installation int64
}

// appJWT signs the app's own short-lived token, for listing its installations.
func (c *config) appJWT() (string, error) {
	enc := base64.RawURLEncoding
	now := time.Now().Unix()
	claims, _ := json.Marshal(map[string]any{"iat": now - 60, "exp": now + 540, "iss": c.appID})
	unsigned := enc.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`)) + "." + enc.EncodeToString(claims)
	digest := sha256.Sum256([]byte(unsigned))
	signature, err := rsa.SignPKCS1v15(rand.Reader, c.signer, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return unsigned + "." + enc.EncodeToString(signature), nil
}

func githubAPI(ctx context.Context, method, path, bearer string, into any) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "https://api.github.com"+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 300))
		return fmt.Errorf("%s %s: %d %s", method, path, res.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(res.Body).Decode(into)
}

// discover lists the scopes to serve: every allowed installation's organization, or its private repositories.
func (c *config) discover(ctx context.Context) ([]scope, error) {
	jwt, err := c.appJWT()
	if err != nil {
		return nil, err
	}
	var installations []struct {
		ID          int64           `json:"id"`
		SuspendedAt json.RawMessage `json:"suspended_at"`
		Account     struct {
			Login string `json:"login"`
			Type  string `json:"type"`
		} `json:"account"`
	}
	if err := githubAPI(ctx, http.MethodGet, "/app/installations?per_page=100", jwt, &installations); err != nil {
		return nil, err
	}
	var scopes []scope
	for _, inst := range installations {
		login := inst.Account.Login
		if !slices.Contains(c.owners, strings.ToLower(login)) {
			slog.Warn("Ignoring an installation outside TUG_OWNERS", "account", login)
			continue
		}
		if len(inst.SuspendedAt) > 0 && string(inst.SuspendedAt) != "null" {
			continue
		}
		var token struct {
			Token string `json:"token"`
		}
		if err := githubAPI(ctx, http.MethodPost, fmt.Sprintf("/app/installations/%d/access_tokens", inst.ID), jwt, &token); err != nil {
			slog.Error("Could not sign in to an installation", "account", login, "error", err)
			continue
		}
		if inst.Account.Type == "Organization" {
			var group struct {
				AllowsPublic bool `json:"allows_public_repositories"`
			}
			if err := githubAPI(ctx, http.MethodGet, fmt.Sprintf("/orgs/%s/actions/runner-groups/%d", login, defaultRunnerGroup), token.Token, &group); err != nil {
				slog.Error("Could not read the Default runner group", "account", login, "error", err)
				continue
			}
			if group.AllowsPublic {
				slog.Error("Skipping an organization whose Default runner group allows public repositories", "account", login)
				continue
			}
			scopes = append(scopes, scope{url: "https://github.com/" + login, installation: inst.ID})
			continue
		}
		for page := 1; ; page++ {
			var repos struct {
				Repositories []struct {
					FullName string `json:"full_name"`
					Private  bool   `json:"private"`
					Archived bool   `json:"archived"`
				} `json:"repositories"`
			}
			if err := githubAPI(ctx, http.MethodGet, fmt.Sprintf("/installation/repositories?per_page=100&page=%d", page), token.Token, &repos); err != nil {
				slog.Error("Could not list repositories", "account", login, "error", err)
				break
			}
			for _, repo := range repos.Repositories {
				// Never public: anyone can open a pull request there, and its code would run here.
				if repo.Private && !repo.Archived {
					scopes = append(scopes, scope{url: "https://github.com/" + repo.FullName, installation: inst.ID})
				}
			}
			if len(repos.Repositories) < 100 {
				break
			}
		}
	}
	return scopes, nil
}

// pool holds the one limit shared by every scope.
type pool struct {
	cfg     *config
	mu      sync.Mutex
	running int
	scalers map[string]*scaler
	adopted map[string][]string // containers left by an earlier run, by scope URL
}

func (p *pool) take() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running >= p.cfg.max {
		return false
	}
	p.running++
	return true
}

// release frees a slot and offers it to every scope, so a job waiting in another account starts next.
func (p *pool) release(ctx context.Context) {
	p.mu.Lock()
	p.running--
	scalers := make([]*scaler, 0, len(p.scalers))
	for _, s := range p.scalers {
		scalers = append(scalers, s)
	}
	p.mu.Unlock()
	for _, s := range scalers {
		go s.fill(ctx)
	}
}

func (p *pool) free() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.cfg.max - p.running
}

type runner struct {
	id      int
	busy    bool
	removed bool
	started time.Time
}

// scaler starts runners for one scope's scale set. It outlives a listener restart, so it keeps counting the runners
// already started; mu guards everything below it.
type scaler struct {
	pool     *pool
	scope    scope
	mu       sync.Mutex
	client   *scaleset.Client
	session  *scaleset.MessageSessionClient
	listener *listener.Listener
	setID    int
	desired  int
	runners  map[string]*runner
}

func (s *scaler) Scale(ctx context.Context, msg *scaleset.RunnerScaleSetMessage) error {
	if msg == nil {
		s.fill(ctx)
		s.reap(ctx)
		return nil
	}
	if len(msg.JobAvailableMessages) > 0 {
		ids := make([]int64, 0, len(msg.JobAvailableMessages))
		for _, job := range msg.JobAvailableMessages {
			ids = append(ids, job.RunnerRequestID)
		}
		if _, err := s.session.AcquireJobs(ctx, ids); err != nil {
			return fmt.Errorf("acquire jobs: %w", err)
		}
	}
	s.mu.Lock()
	for _, job := range msg.JobStartedMessages {
		if r, ok := s.runners[job.RunnerName]; ok {
			r.busy = true
		}
		slog.Info("Job started", "scope", s.scope.url, "repository", job.OwnerName+"/"+job.RepositoryName, "job", job.JobDisplayName, "runner", job.RunnerName)
	}
	if msg.Statistics != nil {
		s.desired = msg.Statistics.TotalAssignedJobs
	}
	s.mu.Unlock()
	s.fill(ctx)
	s.reap(ctx)
	return nil
}

// fill starts runners until this scope has one per assigned job, or the pool is full.
func (s *scaler) fill(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener == nil {
		return
	}
	for len(s.runners) < s.desired && s.pool.take() {
		if err := s.start(ctx); err != nil {
			slog.Error("Could not start a runner", "scope", s.scope.url, "error", err)
			s.pool.mu.Lock()
			s.pool.running--
			s.pool.mu.Unlock()
			break
		}
	}
	s.listener.SetMaxRunners(len(s.runners) + s.pool.free())
}

// reap removes runners that waited too long for a job that was cancelled or went to another runner.
func (s *scaler) reap(ctx context.Context) {
	s.mu.Lock()
	defer s.mu.Unlock()
	extra := len(s.runners) - s.desired
	for name, r := range s.runners {
		if extra <= 0 {
			return
		}
		if r.busy || r.removed || time.Since(r.started) < idleLimit {
			continue
		}
		slog.Info("Removing an idle runner", "scope", s.scope.url, "runner", name)
		// Its exit frees the slot through watch.
		r.removed = true
		extra--
		_ = exec.Command("docker", "rm", "-f", name).Run()
		if r.id > 0 && s.client != nil {
			_ = s.client.RemoveRunner(context.WithoutCancel(ctx), int64(r.id))
		}
	}
}

// start registers a single-use runner and starts its container. Called with s.mu held and a pool slot taken.
func (s *scaler) start(ctx context.Context) error {
	name := fmt.Sprintf("tug-%d", time.Now().UnixNano())
	jit, err := s.client.GenerateJitRunnerConfig(ctx, &scaleset.RunnerScaleSetJitRunnerSetting{Name: name, WorkFolder: "_work"}, s.setID)
	if err != nil {
		return err
	}
	cfg := s.pool.cfg
	cmd := exec.Command("docker", "run", "-d", "--rm", "--name", name, "--label", containerLabel+"="+s.scope.url, "--init",
		"--cpus", cfg.cpus, "--memory", cfg.memory, "--pids-limit", cfg.pids,
		"--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--network", cfg.network,
		"-e", "ACTIONS_RUNNER_INPUT_JITCONFIG", "-e", "TUG_KEYS="+cfg.keys, cfg.image, "./run.sh")
	// Only what Docker's CLI needs, so none of this service's secrets reach it; the config goes by name, off the
	// command line.
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME"), "ACTIONS_RUNNER_INPUT_JITCONFIG=" + jit.EncodedJITConfig}
	if out, err := cmd.CombinedOutput(); err != nil {
		if jit.Runner != nil {
			_ = s.client.RemoveRunner(context.WithoutCancel(ctx), int64(jit.Runner.ID))
		}
		return fmt.Errorf("docker run: %w: %s", err, strings.TrimSpace(string(out)))
	}
	r := &runner{started: time.Now()}
	if jit.Runner != nil {
		r.id = jit.Runner.ID
	}
	s.runners[name] = r
	slog.Info("Runner started", "scope", s.scope.url, "runner", name)
	go s.watch(ctx, name)
	return nil
}

// watch waits for a container to exit, then frees its slot.
func (s *scaler) watch(ctx context.Context, name string) {
	_ = exec.Command("docker", "wait", name).Run()
	s.mu.Lock()
	delete(s.runners, name)
	s.mu.Unlock()
	s.pool.release(context.WithoutCancel(ctx))
}

// serve keeps one scope's scale set listening until ctx ends, restarting it after an error.
func (p *pool) serve(ctx context.Context, sc scope) {
	s := &scaler{pool: p, scope: sc, runners: map[string]*runner{}}
	p.mu.Lock()
	for _, name := range p.adopted[sc.url] {
		// Already counted in p.running; its exit frees the slot through watch.
		s.runners[name] = &runner{busy: true, started: time.Now()}
		go s.watch(ctx, name)
	}
	delete(p.adopted, sc.url)
	p.scalers[sc.url] = s
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.scalers, sc.url)
		p.mu.Unlock()
	}()
	for {
		err := p.listen(ctx, s)
		if ctx.Err() != nil {
			return
		}
		slog.Error("Scale set stopped; restarting in 30 s", "scope", sc.url, "error", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
	}
}

func (p *pool) listen(ctx context.Context, s *scaler) error {
	sc := s.scope
	client, err := scaleset.NewClientWithGitHubApp(scaleset.ClientWithGitHubAppConfig{
		GitHubConfigURL: sc.url,
		GitHubAppAuth:   scaleset.GitHubAppAuth{ClientID: p.cfg.appID, InstallationID: sc.installation, PrivateKey: p.cfg.key},
		SystemInfo:      scaleset.SystemInfo{System: "tug-runners"},
	})
	if err != nil {
		return err
	}
	set, err := client.GetRunnerScaleSet(ctx, defaultRunnerGroup, p.cfg.label)
	if err != nil {
		return fmt.Errorf("get scale set: %w", err)
	}
	if set == nil {
		set, err = client.CreateRunnerScaleSet(ctx, &scaleset.RunnerScaleSet{
			Name:          p.cfg.label,
			RunnerGroupID: defaultRunnerGroup,
			Labels:        []scaleset.Label{{Name: p.cfg.label}},
			RunnerSetting: scaleset.RunnerSetting{DisableUpdate: true},
		})
		if err != nil {
			return fmt.Errorf("create scale set: %w", err)
		}
		slog.Info("Created the scale set", "scope", sc.url, "id", set.ID)
	}
	client.SetSystemInfo(scaleset.SystemInfo{System: "tug-runners", ScaleSetID: set.ID})
	host, _ := os.Hostname()
	session, err := client.MessageSessionClient(ctx, set.ID, host)
	if err != nil {
		return fmt.Errorf("session: %w", err)
	}
	defer session.Close(context.WithoutCancel(ctx))
	l, err := listener.New(session, listener.Config{ScaleSetID: set.ID, MaxRunners: p.free()})
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.client, s.session, s.listener, s.setID = client, session, l, set.ID
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.listener = nil
		s.mu.Unlock()
	}()
	slog.Info("Listening", "scope", sc.url, "scaleSet", set.ID)
	return l.Run(ctx, s)
}

// adopt counts the runners an earlier run left behind, so a restart never stops a running job. A container that
// never took a job is removed, since nothing would assign it one.
func (p *pool) adopt() {
	out, err := exec.Command("docker", "ps", "--filter", "label="+containerLabel, "--format", `{{.Names}} {{.Label "`+containerLabel+`"}}`).Output()
	if err != nil {
		slog.Error("Could not list containers", "error", err)
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, url, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		logs, _ := exec.Command("docker", "logs", name).CombinedOutput()
		if !strings.Contains(string(logs), "Running job") {
			_ = exec.Command("docker", "rm", "-f", name).Run()
			continue
		}
		p.running++
		p.adopted[url] = append(p.adopted[url], name)
		slog.Info("Adopted a running job", "scope", url, "runner", name)
	}
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	cfg, err := loadConfig()
	if err != nil {
		slog.Error("Invalid configuration", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	if err := exec.Command("docker", "pull", "-q", cfg.image).Run(); err != nil {
		slog.Warn("Could not pull the runner image; using the local one", "image", cfg.image, "error", err)
	}
	p := &pool{cfg: cfg, scalers: map[string]*scaler{}, adopted: map[string][]string{}}
	p.adopt()
	slog.Info("Starting", "max", cfg.max, "owners", strings.Join(cfg.owners, ","))

	served := map[string]context.CancelFunc{}
	var wg sync.WaitGroup
	for {
		scopes, err := cfg.discover(ctx)
		if err != nil {
			slog.Error("Could not list the app's installations", "error", err)
		} else {
			current := map[string]bool{}
			for _, sc := range scopes {
				current[sc.url] = true
				if _, ok := served[sc.url]; ok {
					continue
				}
				scopeCtx, cancel := context.WithCancel(ctx)
				served[sc.url] = cancel
				wg.Add(1)
				go func() { defer wg.Done(); p.serve(scopeCtx, sc) }()
			}
			for url, cancel := range served {
				if !current[url] {
					slog.Info("No longer serving", "scope", url)
					cancel()
					delete(served, url)
				}
			}
		}
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case <-time.After(discoverEvery):
		}
	}
}
