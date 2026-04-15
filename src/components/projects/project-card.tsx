'use client';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { STATUS_COLORS, CATEGORY_LABELS } from '@/lib/constants';
import type { Project } from '@/types/project';

export function ProjectCard({ project }: { project: Project }) {
  return (
    <Link href={`/projects/${project.projectId}`}>
      <Card className="cursor-pointer transition-shadow hover:shadow-md">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <CardTitle className="text-base">{project.name}</CardTitle>
            <Badge className={STATUS_COLORS[project.status] || 'bg-muted text-muted-foreground'}>
              {project.status}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            {CATEGORY_LABELS[project.category] || project.category}
          </span>
        </CardHeader>
        <CardContent>
          <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
            {project.descriptions?.brief}
          </p>
          <div className="flex flex-wrap gap-1">
            {project.awsServices.slice(0, 5).map((svc) => (
              <Badge key={svc} variant="outline" className="text-xs">
                {svc}
              </Badge>
            ))}
            {project.awsServices.length > 5 && (
              <Badge variant="outline" className="text-xs">
                +{project.awsServices.length - 5}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
