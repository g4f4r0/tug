package main

// GitHub tells a scale set's listener of a job once, when the job is queued, and only if a listener is connected then.
// A job queued while none was (this service restarting, its host down, or Tug moving between hosts) is never offered
// again: it waits in the queue until GitHub cancels it, a day later. A sweep finds such jobs and queues them again, by
// cancelling their run and re-running its failed jobs, so that this time the listener hears of them.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

var (
	// sweepAfterListen gives a new listener time to hear of the jobs GitHub does tell it of before the first sweep.
	sweepAfterListen = time.Minute
	sweepEvery       = 10 * time.Minute
	// stuckAfter is how long a job may wait for the label while a slot is free; one the listener heard of has started
	// well before then.
	stuckAfter = 5 * time.Minute
	// requeuePoll and requeueTries bound the wait for a cancelled run to stop before it is re-run.
	requeuePoll  = 5 * time.Second
	requeueTries = 24
)

// sweeper sweeps s's scope sweepAfterListen after its listener starts, so a restart recovers what it missed, then
// every sweepEvery, until ctx ends.
func (s *scaler) sweeper(ctx context.Context) {
	wait := sweepAfterListen
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = sweepEvery
		if _, err := s.sweep(ctx, time.Now()); err != nil && ctx.Err() == nil {
			slog.Warn("Could not look for jobs no runner was told of", "scope", s.scope.url, "error", err)
		}
	}
}

// sweep queues again every job of the scope that has waited for the label past stuckAfter while a slot was free, and
// returns how many runs it re-ran. With no free slot, waiting is expected, as acquired jobs wait here for one, so it
// does nothing.
func (s *scaler) sweep(ctx context.Context, now time.Time) (int, error) {
	if s.pool.free() == 0 {
		return 0, nil
	}
	cfg := s.pool.cfg
	repos, err := s.scope.repositories(ctx, cfg.token, now)
	if err != nil {
		return 0, err
	}
	// GitHub drops a job queued for a day, so older runs can't hold one.
	query := url.Values{"created": {">=" + now.Add(-24*time.Hour).UTC().Format(time.RFC3339)}, "per_page": {"100"}}
	requeued := 0
	for _, repo := range repos {
		var list struct {
			Runs []struct {
				ID     int64  `json:"id"`
				Status string `json:"status"`
			} `json:"workflow_runs"`
		}
		if _, err := githubAPI(ctx, fmt.Sprintf("/repos/%s/actions/runs?%s", repo, query.Encode()), cfg.token, &list); err != nil {
			if refused(err) {
				continue
			}
			return requeued, err
		}
		for _, run := range list.Runs {
			if run.Status == "completed" {
				continue
			}
			job, err := stuckJob(ctx, cfg.token, cfg.label, repo, run.ID, now)
			if err != nil {
				return requeued, err
			}
			if job == "" {
				continue
			}
			if err := requeue(ctx, cfg.token, repo, run.ID); err != nil {
				slog.Error("Could not queue a job again that no runner was told of", "scope", s.scope.url, "repository", repo, "run", run.ID, "job", job, "error", err)
				continue
			}
			slog.Info("Queued a job again that no runner was told of", "scope", s.scope.url, "repository", repo, "run", run.ID, "job", job)
			requeued++
		}
	}
	return requeued, nil
}

// repositories lists the repositories a sweep reads: the scope's own, or an organization's pushed to in the last day,
// where a job could have been queued since. Archived repositories run nothing.
func (sc scope) repositories(ctx context.Context, token string, now time.Time) ([]string, error) {
	name := strings.TrimPrefix(sc.url, "https://github.com/")
	if strings.Contains(name, "/") {
		return []string{name}, nil
	}
	var repos []struct {
		FullName string    `json:"full_name"`
		Archived bool      `json:"archived"`
		PushedAt time.Time `json:"pushed_at"`
	}
	if _, err := githubAPI(ctx, "/orgs/"+name+"/repos?type=all&sort=pushed&direction=desc&per_page=100", token, &repos); err != nil {
		return nil, err
	}
	var recent []string
	for _, repo := range repos {
		if !repo.Archived && now.Sub(repo.PushedAt) < 24*time.Hour {
			recent = append(recent, repo.FullName)
		}
	}
	return recent, nil
}

// stuckJob names a job of the run that has waited for the label past stuckAfter, or returns "" when none has, or when
// another of its jobs is running, which cancelling the run would stop; the next sweep looks again.
func stuckJob(ctx context.Context, token, label, repo string, runID int64, now time.Time) (string, error) {
	var jobs struct {
		Jobs []struct {
			Name      string    `json:"name"`
			Status    string    `json:"status"`
			Labels    []string  `json:"labels"`
			CreatedAt time.Time `json:"created_at"`
		} `json:"jobs"`
	}
	if _, err := githubAPI(ctx, fmt.Sprintf("/repos/%s/actions/runs/%d/jobs?filter=latest&per_page=100", repo, runID), token, &jobs); err != nil {
		return "", err
	}
	stuck := ""
	for _, job := range jobs.Jobs {
		if job.Status == "in_progress" {
			return "", nil
		}
		if stuck == "" && job.Status == "queued" && slices.Contains(job.Labels, label) && now.Sub(job.CreatedAt) > stuckAfter {
			stuck = job.Name
		}
	}
	return stuck, nil
}

// requeue cancels a run and, once it has stopped, re-runs its failed jobs: the cancelled ones and those that need
// them. Jobs that passed keep their result.
func requeue(ctx context.Context, token, repo string, runID int64) error {
	path := fmt.Sprintf("/repos/%s/actions/runs/%d", repo, runID)
	if _, err := githubDo(ctx, http.MethodPost, path+"/cancel", token, nil); err != nil {
		return err
	}
	for try := 0; ; try++ {
		var run struct {
			Status string `json:"status"`
		}
		if _, err := githubAPI(ctx, path, token, &run); err != nil {
			return err
		}
		if run.Status == "completed" {
			break
		}
		if try == requeueTries {
			return errors.New("the cancelled run did not stop")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(requeuePoll):
		}
	}
	_, err := githubDo(ctx, http.MethodPost, path+"/rerun-failed-jobs", token, nil)
	return err
}
