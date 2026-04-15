import { ProjectDetailClient } from './project-detail-client';

const PROJECT_IDS = [
  'contento',
  'sellebra',
  'mbe',
  'applicator',
  'gomad',
  'atlassinator',
  'dasher',
  'songster',
  'mycelium',
  'admin-hub',
  'identity-broker',
];

export function generateStaticParams() {
  return PROJECT_IDS.map((id) => ({ id }));
}

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectDetailClient id={id} />;
}
