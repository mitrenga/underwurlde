<?php

require_once 'app/svision/php/abstractAboutPage.php';

/**
 * The /about page: the story of the original Underwurlde and of this remake.
 * M1 text; the final content comes with M7.
 */
class AboutPage extends AbstractAboutPage {

  protected function aboutData() {
    return [
      'image' => 'images/cover.png',
      'sections' => [
        [
          'heading' => 'The original game (1984)',
          'html' =>
            '<p>Underwurlde was released by Ultimate Play The Game late in 1984 for the 48K ZX Spectrum, '.
            'the middle part of the Sabreman trilogy between Sabre Wulf and Knight Lore. Sabreman falls '.
            'into a world of 597 screens — a castle and the caves below it — and has to find one of three '.
            'exits, each leading into a different sequel: Knight Lore, Pentagram and Mire Mare.</p>'.
            '<p>Its defining idea is that the monsters do not kill you. They bounce you away, and the only '.
            'thing that kills is a long fall — so the danger is never the contact itself but where the '.
            'contact throws you. Sabreman starts with six lives, catches ceilings and ropes on his own, '.
            'rides volcanic bubbles up through the caves, and carries one of four weapons at a time: '.
            'the catapult he starts with, a bow, a sword and a torch. The three exit guardians are immune '.
            'to everything but their own one weapon. Crash gave it 92%.</p>',
        ],
        [
          'heading' => 'This remake',
          'html' =>
            '<p>This is a faithful remake, rewritten for the web browser rather than emulated. The graphics '.
            'and the world are taken out of the original program, not redrawn, and the rules come from the '.
            'original instructions and from the disassembly of the game — where a rule cannot be shown, it '.
            'is left as an open question rather than guessed. Even the frame rate is the Spectrum\'s own '.
            '50.08 Hz, and the attribute clash of the hardware is reproduced instead of cleaned up.</p>'.
            '<p>It runs directly in your browser — nothing to install, nothing to download. Keyboard '.
            '(the original Q W R E T, or the arrow keys), touch controls and gamepads are supported.</p>'.$this->installNote(),
        ],
        [
          'heading' => 'Other games',
          'html' =>
            '<p>This remake is one of a growing collection of classic games from the 8-bit and 16-bit era '.
            '— ZX Spectrum, Commodore 64, arcade and more — rebuilt faithfully on the same library and '.
            'playable in your browser, free of charge. Browse the whole collection at '.
            '<a href="https://retrogames.free/" target="_blank" rel="noopener">retrogames.free</a>.</p>',
        ],
      ],
      'links' => [
        ['label' => 'Underwurlde at Spectrum Computing', 'url' => 'https://spectrumcomputing.co.uk/entry/9446/ZX-Spectrum/Underwurlde'],
        ['label' => 'Underwurlde at World of Spectrum', 'url' => 'https://worldofspectrum.org/archive/software/games/underwurlde-ultimate-play-the-game'],
      ],
      'footer' =>
        '<p>An unofficial fan remake. The original game and its artwork belong to their authors '.
        '(Ultimate Play The Game, today Rare/Microsoft). '.
        'The remake\'s source code is licensed under <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a>.</p>',
    ];
  } // aboutData

} // AboutPage
