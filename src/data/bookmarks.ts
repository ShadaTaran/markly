import type { Bookmark } from "@/types/bookmark";

export const mockBookmarks: Bookmark[] = [
  {
    id: "github",
    title: "GitHub",
    url: "https://github.com",
    description:
      "The world's leading platform for version control and collaborative software development.",
    category: "Development",
    tags: ["git", "code", "collaboration"],
    favorite: true,
  },
  {
    id: "stack-overflow",
    title: "Stack Overflow",
    url: "https://stackoverflow.com",
    description:
      "A question-and-answer community where developers learn, share knowledge, and build careers.",
    category: "Development",
    tags: ["community", "q&a", "debugging"],
    favorite: false,
  },
  {
    id: "vercel",
    title: "Vercel",
    url: "https://vercel.com",
    description:
      "Cloud platform for building, deploying, and scaling frontend applications and static sites.",
    category: "Development",
    tags: ["hosting", "deployment", "next.js"],
    favorite: false,
  },
  {
    id: "mdn",
    title: "MDN Web Docs",
    url: "https://developer.mozilla.org",
    description:
      "Comprehensive, trustworthy documentation for HTML, CSS, JavaScript, and web APIs.",
    category: "Reference",
    tags: ["docs", "html", "css", "javascript"],
    favorite: false,
  },
  {
    id: "react-docs",
    title: "React Documentation",
    url: "https://react.dev",
    description:
      "The official guide and API reference for building user interfaces with React.",
    category: "Reference",
    tags: ["react", "javascript", "ui"],
    favorite: true,
  },
  {
    id: "figma",
    title: "Figma",
    url: "https://figma.com",
    description:
      "A collaborative interface design tool for creating, prototyping, and reviewing UI.",
    category: "Design",
    tags: ["design", "ui", "prototyping"],
    favorite: true,
  },
  {
    id: "dribbble",
    title: "Dribbble",
    url: "https://dribbble.com",
    description:
      "A community for discovering and showcasing design work, portfolios, and inspiration.",
    category: "Design",
    tags: ["inspiration", "portfolio"],
    favorite: false,
  },
  {
    id: "notion",
    title: "Notion",
    url: "https://notion.so",
    description:
      "An all-in-one workspace for notes, documents, wikis, and project planning.",
    category: "Productivity",
    tags: ["notes", "planning", "docs"],
    favorite: false,
  },
  {
    id: "linear",
    title: "Linear",
    url: "https://linear.app",
    description:
      "A streamlined issue tracking and project management tool for software teams.",
    category: "Productivity",
    tags: ["planning", "issues", "workflow"],
    favorite: false,
  },
];
