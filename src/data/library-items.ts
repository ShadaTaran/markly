import type { WebsiteItem } from "@/types/library-item";

export const starterLibraryItems: WebsiteItem[] = [
  {
    id: "github",
    type: "website",
    title: "GitHub",
    url: "https://github.com",
    description:
      "The world's leading platform for version control and collaborative software development.",
    category: "Development",
    tags: ["git", "code", "collaboration"],
    favorite: true,
    createdAt: "2026-08-01T09:00:00.000Z",
  },
  {
    id: "stack-overflow",
    type: "website",
    title: "Stack Overflow",
    url: "https://stackoverflow.com",
    description:
      "A question-and-answer community where developers learn, share knowledge, and build careers.",
    category: "Development",
    tags: ["community", "q&a", "debugging"],
    favorite: false,
    createdAt: "2026-08-02T09:00:00.000Z",
  },
  {
    id: "vercel",
    type: "website",
    title: "Vercel",
    url: "https://vercel.com",
    description:
      "Cloud platform for building, deploying, and scaling frontend applications and static sites.",
    category: "Development",
    tags: ["hosting", "deployment", "next.js"],
    favorite: false,
    createdAt: "2026-08-03T09:00:00.000Z",
  },
  {
    id: "mdn",
    type: "website",
    title: "MDN Web Docs",
    url: "https://developer.mozilla.org",
    description:
      "Comprehensive, trustworthy documentation for HTML, CSS, JavaScript, and web APIs.",
    category: "Reference",
    tags: ["docs", "html", "css", "javascript"],
    favorite: false,
    createdAt: "2026-08-04T09:00:00.000Z",
  },
  {
    id: "react-docs",
    type: "website",
    title: "React Documentation",
    url: "https://react.dev",
    description:
      "The official guide and API reference for building user interfaces with React.",
    category: "Reference",
    tags: ["react", "javascript", "ui"],
    favorite: true,
    createdAt: "2026-08-05T09:00:00.000Z",
  },
  {
    id: "figma",
    type: "website",
    title: "Figma",
    url: "https://figma.com",
    description:
      "A collaborative interface design tool for creating, prototyping, and reviewing UI.",
    category: "Design",
    tags: ["design", "ui", "prototyping"],
    favorite: true,
    createdAt: "2026-08-06T09:00:00.000Z",
  },
  {
    id: "dribbble",
    type: "website",
    title: "Dribbble",
    url: "https://dribbble.com",
    description:
      "A community for discovering and showcasing design work, portfolios, and inspiration.",
    category: "Design",
    tags: ["inspiration", "portfolio"],
    favorite: false,
    createdAt: "2026-08-07T09:00:00.000Z",
  },
  {
    id: "notion",
    type: "website",
    title: "Notion",
    url: "https://notion.so",
    description:
      "An all-in-one workspace for notes, documents, wikis, and project planning.",
    category: "Productivity",
    tags: ["notes", "planning", "docs"],
    favorite: false,
    createdAt: "2026-08-08T09:00:00.000Z",
  },
  {
    id: "linear",
    type: "website",
    title: "Linear",
    url: "https://linear.app",
    description:
      "A streamlined issue tracking and project management tool for software teams.",
    category: "Productivity",
    tags: ["planning", "issues", "workflow"],
    favorite: false,
    createdAt: "2026-08-09T09:00:00.000Z",
  },
];
