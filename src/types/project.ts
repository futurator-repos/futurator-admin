export type ProjectStatus = 'planning' | 'in-progress' | 'beta' | 'active';
export type ProjectCategory =
  | 'independent-companies'
  | 'joint-venture'
  | 'personal'
  | 'shared-infra';

export interface ProjectDescriptions {
  headline: string;
  brief: string;
  summary: string;
  full: string;
  aiContext: string;
  homepageFlags: {
    headline: boolean;
    brief: boolean;
    summary: boolean;
  };
}

export interface ProjectMedia {
  id: string;
  url: string;
  alt: string;
  showOnHomepage: boolean;
  order: number;
}

export interface Feature {
  id: string;
  name: string;
  status: ProjectStatus;
  awsServices: string[];
  aiProviders: string[];
  integrations: string[];
}

export interface Project {
  projectId: string;
  name: string;
  status: ProjectStatus;
  category: ProjectCategory;
  descriptions: ProjectDescriptions;
  media: ProjectMedia[];
  features: Feature[];
  awsServices: string[];
  team: string[];
  budget?: { monthlyLimit: number };
  publishedToHomepage: boolean;
  homepageOrder: number;
  createdAt: string;
  updatedAt: string;
}
