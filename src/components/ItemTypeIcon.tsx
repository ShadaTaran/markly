import type { ComponentType, SVGProps } from "react";
import type { LibraryItemType } from "@/types/library-item";
import {
  BookIcon,
  BookOpenIcon,
  ClapperboardIcon,
  FilmIcon,
  GamepadIcon,
  GlobeIcon,
  TvIcon,
} from "@/components/icons";

const ICON_BY_TYPE: Record<LibraryItemType, ComponentType<SVGProps<SVGSVGElement>>> = {
  website: GlobeIcon,
  anime: TvIcon,
  manga: BookOpenIcon,
  novel: BookIcon,
  game: GamepadIcon,
  movie: FilmIcon,
  series: ClapperboardIcon,
  article: GlobeIcon,
  video: FilmIcon,
  other: GlobeIcon,
};

interface ItemTypeIconProps extends SVGProps<SVGSVGElement> {
  type: LibraryItemType;
}

export function ItemTypeIcon({ type, ...props }: ItemTypeIconProps) {
  const Icon = ICON_BY_TYPE[type];
  return <Icon {...props} />;
}
