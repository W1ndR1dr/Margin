/**
 * Margin's design system.
 *
 * Everything the app is allowed to render as a control comes from here.
 * UI-OVERHAUL.md §1: no native browser controls anywhere, one component each,
 * styled from tokens, keyboard-accessible, with a visible custom focus ring.
 *
 * Import the stylesheet once, here, so a component can never be used without
 * its styles.
 */
import './ui.css';

export { Icon, isIconName, type IconName, type IconProps } from './Icon';
export { MarginMark, type MarginMarkProps } from './MarginMark';

export {
  Button,
  Toggle,
  Segmented,
  Slider,
  Chip,
  Pill,
  Field,
  Kbd,
  Popover,
  PopItem,
  SeverityGlyph,
  type ButtonProps,
  type ButtonTone,
  type ButtonSize,
  type ToggleProps,
  type SegmentedProps,
  type SegmentedOption,
  type SliderProps,
  type ChipProps,
  type PillProps,
  type FieldProps,
  type PopoverProps,
  type PopItemProps,
  type Severity,
} from './controls';

export { Tabs, TabPanel, type TabsProps, type TabDef } from './Tabs';
export { Tile, TileRow, type TileProps } from './Tile';
export { Drawer, Modal, type DrawerProps, type ModalProps } from './Drawer';
export { Palette, filterPalette, fuzzyScore, type PaletteItem, type PaletteProps } from './Palette';
export { ToastStack, Banner, type ToastData, type ToastKind } from './Toast';
export { Tooltip, WithTooltip, type TooltipProps } from './Tooltip';
export { Scrubber, type ScrubberProps, type ScrubberMarker, type MarkerTone } from './Scrubber';
