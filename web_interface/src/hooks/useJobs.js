// Live list of background jobs (installs) from the server's event stream.
import { useEffect, useRef, useState } from 'react';
import { subscribeJobs } from '../api.js';

function upsertJob(jobs, job) {
  const index = jobs.findIndex((existing) => existing.id === job.id);
  if (index === -1) return [job, ...jobs];
  const next = jobs.slice();
  next[index] = job;
  return next;
}

/**
 * Returns { jobs, connected }. `onJobFinished(job)` fires once when a job we saw running
 * stops (done, error or cancelled); jobs that were already finished when we connected are ignored.
 */
export function useJobs({ onJobFinished }) {
  const [jobs, setJobs] = useState([]);
  const [connected, setConnected] = useState(true);
  const lastStatusById = useRef(new Map());

  // Read the callback through a ref so a new callback identity doesn't reopen the stream.
  const onJobFinishedRef = useRef(onJobFinished);
  useEffect(() => {
    onJobFinishedRef.current = onJobFinished;
  });

  useEffect(
    () =>
      subscribeJobs({
        onConnection: setConnected,
        onSnapshot: (snapshot) => {
          snapshot.forEach((job) => lastStatusById.current.set(job.id, job.status));
          setJobs(snapshot);
        },
        onUpdate: (job) => {
          const previousStatus = lastStatusById.current.get(job.id);
          lastStatusById.current.set(job.id, job.status);
          if (previousStatus === 'running' && job.status !== 'running') onJobFinishedRef.current?.(job);
          setJobs((all) => upsertJob(all, job));
        },
        onRemoved: (id) => setJobs((all) => all.filter((job) => job.id !== id)),
      }),
    [],
  );

  return { jobs, connected };
}
