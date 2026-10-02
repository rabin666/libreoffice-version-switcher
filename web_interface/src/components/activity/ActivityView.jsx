// "Activity" tab: background downloads and installs with live progress.
import { Empty, LinkButton, ViewHeader } from '../ui/index.js';
import JobCard from './JobCard.jsx';

const DESCRIPTION = 'Downloads and installs started from this window.';

export default function ActivityView({ jobs, goTo }) {
  if (!jobs.length) {
    return (
      <section className="view">
        <ViewHeader title="Activity" description={DESCRIPTION} />
        <Empty title="Nothing running">
          Start an install from <LinkButton onClick={() => goTo('available')}>Available</LinkButton>.
        </Empty>
      </section>
    );
  }

  return (
    <section className="view">
      <ViewHeader title="Activity" description={`${DESCRIPTION} They keep running if you close the page.`} />
      <div className="job-list">
        {jobs.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
      </div>
    </section>
  );
}
