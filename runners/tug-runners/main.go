// tug-runners starts one single-use GitHub Actions runner, in Docker on the network tug, for each job queued for the
// label tug in every account listed in TUG_ACCOUNTS, signed in as TUG_GITHUB_TOKEN's user. It never runs more than
// TUG_MAX_RUNNERS at once across all of them, which share the host's CPUs and memory evenly, so the host should run
// nothing else. Organizations get one runner scale set each, in their Default runner group, which must not allow
// public repositories; the token's own user gets one per private repository it owns. No secret enters a container: it
// gets only its single-use runner config and TUG_KEYS.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
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
	token   string
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

// runnerImage is GitHub's runner image; tug-cleanup.service pulls it again after removing unused images.
const runnerImage = "ghcr.io/actions/actions-runner:latest"

// loadConfig reads TUG_GITHUB_TOKEN, TUG_ACCOUNTS and optional TUG_MAX_RUNNERS (default 4).
func loadConfig() (*config, error) {
	c := &config{
		token:   strings.TrimSpace(os.Getenv("TUG_GITHUB_TOKEN")),
		label:   "tug",
		image:   runnerImage,
		network: "tug",
		keys:    "http://172.30.99.1:8787",
		pids:    "4096",
	}
	for _, account := range strings.Split(os.Getenv("TUG_ACCOUNTS"), ",") {
		if account = strings.ToLower(strings.TrimSpace(account)); account != "" {
			c.owners = append(c.owners, account)
		}
	}
	c.max = 4
	if value := strings.TrimSpace(os.Getenv("TUG_MAX_RUNNERS")); value != "" {
		max, err := strconv.Atoi(value)
		if err != nil || max < 1 {
			return nil, fmt.Errorf("TUG_MAX_RUNNERS must be a positive number")
		}
		c.max = max
	}
	if c.token == "" || len(c.owners) == 0 {
		return nil, errors.New("TUG_GITHUB_TOKEN and TUG_ACCOUNTS are required")
	}
	c.cpus, c.memory = share(runtime.NumCPU(), hostMemory(), c.max)
	return c, nil
}

// share splits the host's CPUs and memory evenly between max containers, as Docker's --cpus and --memory.
func share(cpus int, memory int64, containers int) (string, string) {
	perCPU := max(float64(cpus)/float64(containers), 1)
	return strconv.FormatFloat(perCPU, 'f', 2, 64), strconv.FormatInt(max(memory/int64(containers), 1<<30), 10)
}

// hostMemory is the host's total memory in bytes, from /proc/meminfo, or 8 GiB when it can't be read.
func hostMemory() int64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if fields := strings.Fields(line); len(fields) >= 2 && fields[0] == "MemTotal:" {
				if kb, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
					return kb * 1024
				}
			}
		}
	}
	return 8 << 30
}

// A scope is where one runner scale set lives: an organization, or a repository of the token's user.
type scope struct {
	url string
}

// apiBase is GitHub's REST API; tests point it at a fake.
var apiBase = "https://api.github.com"

// dockerBin is Docker's CLI; a test points it at a script.
var dockerBin = "docker"

// dockerTimeout bounds every Docker command but wait, which lasts as long as its job. pull and run, which may download
// the runner image, get five times as long.
var dockerTimeout = 2 * time.Minute

// runDocker runs Docker's CLI and returns its output. The command gets only PATH, HOME, DOCKER_HOST, which names Tug's
// rootless Docker, and env, so none of this service's secrets reach it.
func runDocker(env []string, args ...string) ([]byte, error) {
	ctx := context.Background()
	if args[0] != "wait" {
		limit := dockerTimeout
		if args[0] == "pull" || args[0] == "run" {
			limit *= 5
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, limit)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, dockerBin, args...)
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "HOME=" + os.Getenv("HOME")}, env...)
	if host := os.Getenv("DOCKER_HOST"); host != "" {
		cmd.Env = append(cmd.Env, "DOCKER_HOST="+host)
	}
	out, err := cmd.Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		err = fmt.Errorf("%w: %s", err, strings.TrimSpace(string(exit.Stderr)))
	}
	return out, err
}

// docker is runDocker; tests replace it.
var docker = runDocker

// apiError is a response GitHub refused, with its status.
type apiError struct {
	status  int
	message string
}

func (e *apiError) Error() string { return e.message }

// refused is GitHub denying the token access: unauthorized, forbidden, or hidden as not found.
func refused(err error) bool {
	var e *apiError
	return errors.As(err, &e) && (e.status == http.StatusUnauthorized || e.status == http.StatusForbidden || e.status == http.StatusNotFound)
}

// githubAPI reads one REST API path as the token's user, and returns the response's headers.
func githubAPI(ctx context.Context, path, token string, into any) (http.Header, error) {
	return githubDo(ctx, http.MethodGet, path, token, into)
}

// githubDo sends one REST API request, with no body, as the token's user. It decodes the answer into into, unless into
// is nil, and returns the response's headers.
func githubDo(ctx context.Context, method, path, token string, into any) (http.Header, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, apiBase+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 300))
		return nil, &apiError{res.StatusCode, fmt.Sprintf("%s %s: %d %s", method, path, res.StatusCode, strings.TrimSpace(string(body)))}
	}
	if into == nil {
		return res.Header, nil
	}
	return res.Header, json.NewDecoder(res.Body).Decode(into)
}

// missingScopes names the scopes the service needs that a classic token lacks. GitHub lists a classic token's scopes
// in X-OAuth-Scopes; other tokens get no such header, and nothing to check.
func missingScopes(header http.Header) []string {
	values := header.Values("X-OAuth-Scopes")
	if len(values) == 0 {
		return nil
	}
	var granted, missing []string
	for _, name := range strings.Split(strings.Join(values, ","), ",") {
		granted = append(granted, strings.TrimSpace(name))
	}
	for _, name := range []string{"repo", "admin:org"} {
		if !slices.Contains(granted, name) {
			missing = append(missing, name)
		}
	}
	return missing
}

// checkToken logs, once at startup, a token that can't sign in or lacks a scope the service needs.
func (c *config) checkToken(ctx context.Context) {
	var user struct{}
	header, err := githubAPI(ctx, "/user", c.token, &user)
	if err != nil {
		slog.Error("Could not sign in with TUG_GITHUB_TOKEN", "error", err)
	} else if missing := missingScopes(header); len(missing) > 0 {
		slog.Error("TUG_GITHUB_TOKEN lacks scopes: it needs a classic token with repo and admin:org", "missing", strings.Join(missing, ","))
	}
}

// discover lists the scopes to serve: each organization in TUG_ACCOUNTS whose runners the token can manage, and the
// token user's own private repositories when that user is listed. GitHub refusing an account skips it; any other
// failure fails the round, so the scopes already served stay served.
func (c *config) discover(ctx context.Context) ([]scope, error) {
	var user struct {
		Login string `json:"login"`
	}
	if _, err := githubAPI(ctx, "/user", c.token, &user); err != nil {
		return nil, err
	}
	var scopes []scope
	for _, owner := range c.owners {
		if owner == strings.ToLower(user.Login) {
			for page := 1; ; page++ {
				var repos []struct {
					FullName string `json:"full_name"`
					Private  bool   `json:"private"`
					Archived bool   `json:"archived"`
				}
				if _, err := githubAPI(ctx, fmt.Sprintf("/user/repos?affiliation=owner&visibility=private&per_page=100&page=%d", page), c.token, &repos); err != nil {
					// A partial list would stop serving the repositories it missed.
					return nil, fmt.Errorf("list %s's repositories: %w", user.Login, err)
				}
				for _, repo := range repos {
					// Never public: anyone can open a pull request there, and its code would run here.
					if repo.Private && !repo.Archived {
						scopes = append(scopes, scope{url: "https://github.com/" + repo.FullName})
					}
				}
				if len(repos) < 100 {
					break
				}
			}
			continue
		}
		var account struct {
			Login string `json:"login"`
			Type  string `json:"type"`
		}
		if _, err := githubAPI(ctx, "/users/"+owner, c.token, &account); err != nil {
			if !refused(err) {
				return nil, err
			}
			slog.Error("Skipping an account GitHub doesn't show", "account", owner, "error", err)
			continue
		}
		if account.Type != "Organization" {
			slog.Error("Skipping another user's account: the token serves only its own user's repositories", "account", account.Login)
			continue
		}
		var group struct {
			AllowsPublic bool `json:"allows_public_repositories"`
		}
		if _, err := githubAPI(ctx, fmt.Sprintf("/orgs/%s/actions/runner-groups/%d", account.Login, defaultRunnerGroup), c.token, &group); err != nil {
			if !refused(err) {
				return nil, err
			}
			slog.Error("Skipping an organization whose runners the token can't manage: it needs an owner's token with admin:org", "account", account.Login, "error", err)
			continue
		}
		if group.AllowsPublic {
			slog.Error("Skipping an organization whose Default runner group allows public repositories", "account", account.Login)
			continue
		}
		scopes = append(scopes, scope{url: "https://github.com/" + account.Login})
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

// The parts of the scale set client a scaler uses; tests fake them.
type runnerAPI interface {
	GenerateJitRunnerConfig(ctx context.Context, setting *scaleset.RunnerScaleSetJitRunnerSetting, scaleSetID int) (*scaleset.RunnerScaleSetJitRunnerConfig, error)
	RemoveRunner(ctx context.Context, runnerID int64) error
}

type jobSession interface {
	AcquireJobs(ctx context.Context, requestIDs []int64) ([]int64, error)
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
	pool      *pool
	scope     scope
	mu        sync.Mutex
	client    runnerAPI
	session   jobSession
	listening bool
	setID     int
	desired   int
	runners   map[string]*runner
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
	if !s.listening {
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
		_, _ = docker(nil, "rm", "-f", name)
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
	// The config goes by name from the environment, off the command line.
	if _, err := docker([]string{"ACTIONS_RUNNER_INPUT_JITCONFIG=" + jit.EncodedJITConfig},
		"run", "-d", "--rm", "--name", name, "--label", containerLabel+"="+s.scope.url, "--init",
		"--cpus", cfg.cpus, "--memory", cfg.memory, "--pids-limit", cfg.pids,
		"--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--network", cfg.network,
		"-e", "ACTIONS_RUNNER_INPUT_JITCONFIG", "-e", "TUG_KEYS="+cfg.keys, cfg.image, "./run.sh"); err != nil {
		if jit.Runner != nil {
			_ = s.client.RemoveRunner(context.WithoutCancel(ctx), int64(jit.Runner.ID))
		}
		return fmt.Errorf("docker run: %w", err)
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
	_, _ = docker(nil, "wait", name)
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
		// Counted in p.running, and freed by watchAdopted.
		s.runners[name] = &runner{busy: true, started: time.Now()}
	}
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
	client, err := scaleset.NewClientWithPersonalAccessToken(scaleset.NewClientWithPersonalAccessTokenConfig{
		GitHubConfigURL:     sc.url,
		PersonalAccessToken: p.cfg.token,
		SystemInfo:          scaleset.SystemInfo{System: "tug-runners"},
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
	l, err := listener.New(session, p.listenerConfig(set.ID))
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.client, s.session, s.listening, s.setID = client, session, true, set.ID
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.listening = false
		s.mu.Unlock()
	}()
	slog.Info("Listening", "scope", sc.url, "scaleSet", set.ID)
	// Jobs queued before this session, while no listener was told of them, are queued again; see recover.go.
	sweepCtx, stopSweeping := context.WithCancel(ctx)
	defer stopSweeping()
	go s.sweeper(sweepCtx)
	return l.Run(ctx, s)
}

// listenerConfig always reports the whole pool: GitHub assigns a scale set no jobs while it reports no room, and looks
// again only when another job is queued. Jobs past the free slots wait here, acquired, until release offers them one.
func (p *pool) listenerConfig(setID int) listener.Config {
	return listener.Config{ScaleSetID: setID, MaxRunners: p.cfg.max}
}

// adopt counts the runners an earlier run left behind, so a restart never stops a running job. A container that
// never took a job is removed, since nothing would assign it one.
func (p *pool) adopt() {
	out, err := docker(nil, "ps", "--filter", "label="+containerLabel, "--format", `{{.Names}} {{.Label "`+containerLabel+`"}}`)
	if err != nil {
		slog.Error("Could not list containers", "error", err)
		return
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, url, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		// The runner prints a handful of lines before "Running job", and nothing more until the job ends.
		logs, _ := docker(nil, "logs", "--tail", "100", name)
		if !strings.Contains(string(logs), "Running job") {
			_, _ = docker(nil, "rm", "-f", name)
			continue
		}
		p.mu.Lock()
		p.running++
		p.adopted[url] = append(p.adopted[url], name)
		p.mu.Unlock()
		slog.Info("Adopted a running job", "scope", url, "runner", name)
		go p.watchAdopted(url, name)
	}
}

// watchAdopted frees an adopted container's slot when it exits, whether or not its scope is still served.
func (p *pool) watchAdopted(url, name string) {
	_, _ = docker(nil, "wait", name)
	p.mu.Lock()
	p.adopted[url] = slices.DeleteFunc(p.adopted[url], func(n string) bool { return n == name })
	if len(p.adopted[url]) == 0 {
		delete(p.adopted, url)
	}
	s := p.scalers[url]
	p.mu.Unlock()
	if s != nil {
		s.mu.Lock()
		delete(s.runners, name)
		s.mu.Unlock()
	}
	p.release(context.Background())
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

	if _, err := docker(nil, "pull", "-q", cfg.image); err != nil {
		slog.Warn("Could not pull the runner image; using the local one", "image", cfg.image, "error", err)
	}
	p := &pool{cfg: cfg, scalers: map[string]*scaler{}, adopted: map[string][]string{}}
	p.adopt()
	slog.Info("Starting", "max", cfg.max, "cpus", cfg.cpus, "memory", cfg.memory, "accounts", strings.Join(cfg.owners, ","))
	cfg.checkToken(ctx)

	served := map[string]context.CancelFunc{}
	var wg sync.WaitGroup
	for {
		scopes, err := cfg.discover(ctx)
		if err != nil {
			slog.Error("Could not find the accounts to serve", "error", err)
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
