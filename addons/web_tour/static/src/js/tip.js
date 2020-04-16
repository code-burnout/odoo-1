odoo.define('web_tour.Tip', function(require) {
"use strict";

var config = require('web.config');
var core = require('web.core');
var Widget = require('web.Widget');
var _t = core._t;

var Tip = Widget.extend({
    template: "Tip",
    xmlDependencies: ['/web_tour/static/src/xml/tip.xml'],
    events: {
        click: '_onTipClicked',
        mouseenter: '_onMouseEnter',
        mouseleave: '_onMouseLeave',
        transitionend: '_onTransitionEnd',
        'click .btn_consume_event': '_onNextStep',
    },

    /**
     * @param {Widget} parent
     * @param {Object} [info] description of the tip, containing the following keys:
     *  - content [String] the html content of the tip
     *  - event_handlers [Object] description of optional event handlers to bind to the tip:
     *    - event [String] the event name
     *    - selector [String] the jQuery selector on which the event should be bound
     *    - handler [function] the handler
     *  - position [String] tip's position ('top', 'right', 'left' or 'bottom'), default 'right'
     *  - width [int] the width in px of the tip when opened, default 270
     *  - space [int] space in px between anchor and tip, default 10
     *  - hidden [boolean] if true, the tip won't be visible (but the handlers will still be
     *    bound on the anchor, so that the tip is consumed if the user clicks on it)
     *  - overlay [Object] x and y values for the number of pixels the mouseout detection area
     *    overlaps the opened tip, default {x: 50, y: 50}
     */
    init: function(parent, info) {
        this._super(parent);
        this.info = _.defaults(info, {
            position: "right",
            width: 270,
            space: 10,
            overlay: {
                x: 50,
                y: 50,
            },
            scrollContent: _t("Scroll to reach the next step."),
        });
        this.position = {
            top: "50%",
            left: "50%",
        };
        this.initialPosition = this.info.position;
        this.viewPortState = 'in';
        this._onAncestorScroll = _.throttle(this._onAncestorScroll, 50);
    },
    /**
     * @param {jQuery} $anchor the node on which the tip should be placed
     */
    attach_to: async function ($anchor) {
        this._setupAnchor($anchor);
        this.is_anchor_fixed_position = this.$anchor.css("position") === "fixed";

        if (this.info.optional === "true") {
            this.info.content += "<button class='btn btn-link btn_consume_event'>" + _t('Next Step') + "</button>";
        }
        // The body never needs to have the o_tooltip_parent class. It is a
        // safe place to put the tip in the DOM at initialization and be able
        // to compute its dimensions and reposition it if required.
        return this.appendTo(document.body);
    },
    start: function() {
        this.$tooltip_overlay = this.$(".o_tooltip_overlay");
        this.$tooltip_content = this.$(".o_tooltip_content");
        this.init_width = this.$el.innerWidth();
        this.init_height = this.$el.innerHeight();
        this.double_border_width = this.$el.outerWidth() - this.init_width;
        this.content_width = this.$tooltip_content.outerWidth(true);
        this.content_height = this.$tooltip_content.outerHeight(true);
        this.$tooltip_content.html(this.info.scrollContent);
        this.scrollContentWidth = this.$tooltip_content.outerWidth(true);
        this.scrollContentHeight = this.$tooltip_content.outerHeight(true);
        this.$tooltip_content.html(this.info.content);
        if (this.info.optional === "true") {
            this.content_height += this.$tooltip_content.children('button').outerHeight() + 5; // +5 to add a small margin
        }
        this.$window = $(window);

        this.$tooltip_content.css({
            width: "100%",
            height: "100%",
        });

        _.each(this.info.event_handlers, (function(data) {
            this.$tooltip_content.on(data.event, data.selector, data.handler);
        }).bind(this));

        this._bind_anchor_events();
        this._updatePosition(true);

        this.$el.toggleClass('d-none', !!this.info.hidden);
        this.$el.css("opacity", 1);
        core.bus.on("resize", this, _.debounce(function () {
            if (this.tip_opened) {
                this._to_bubble_mode(true);
            } else {
                this._reposition();
            }
        }, 500));

        return this._super.apply(this, arguments);
    },
    destroy: function () {
        this._unbind_anchor_events();
        clearTimeout(this.timerIn);
        clearTimeout(this.timerOut);
        // clear this timeout so that we won't call _updatePosition after we
        // destroy the widget and leave an undesired bubble.
        clearTimeout(this._transitionEndTimer);

        // Do not remove the parent class if it contains other tooltips
        const _removeParentClass = $el => {
            if ($el.children(".o_tooltip").not(this.$el[0]).length === 0) {
                $el.removeClass("o_tooltip_parent");
            }
        };
        _removeParentClass(this.$ideal_location);
        _removeParentClass(this.$furtherIdealLocation);

        return this._super.apply(this, arguments);
    },
    update: function ($anchor) {
        // We unbind/rebind events on each update because we support widgets
        // detaching and re-attaching nodes to their DOM element without keeping
        // the initial event handlers, with said node being potential tip
        // anchors (e.g. FieldMonetary > input element).
        this._unbind_anchor_events();
        if (!$anchor.is(this.$anchor)) {
            this._setupAnchor($anchor);
        }
        this._bind_anchor_events();
        if (!this.$el) {
            // Ideally this case should not happen but this is still possible,
            // as update may be called before the `start` method is called.
            // The `start` method is calling _updatePosition too anyway.
            return;
        }
        this._updatePosition(true);
    },

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * @private
     * @param {jQuery} $anchor
     */
    _setupAnchor: function ($anchor) {
        this.$anchor = $anchor;
        this.$actualAnchor = this.$anchor;
        this.$ideal_location = this._get_ideal_location();
        this.$furtherIdealLocation = this._get_ideal_location(this.$ideal_location);
    },
    /**
     * Figures out which direction the tip should take and if it is at the
     * bottom or the top of the targeted element or if it's an indicator to
     * scroll. Relocates and repositions if necessary.
     *
     * @private
     * @param {boolean} [forceReposition=false]
     */
    _updatePosition: function (forceReposition = false) {
        if (this.info.hidden) {
            return;
        }
        let halfHeight = 0;
        if (this.initialPosition === 'right' || this.initialPosition === 'left') {
            halfHeight = this.$anchor.innerHeight() / 2;
        }

        const paddingTop = parseInt(this.$ideal_location.css('padding-top'));
        const topViewport = window.pageYOffset + paddingTop;
        const botViewport = window.pageYOffset + window.innerHeight;
        const topOffset = this.$anchor.offset().top;
        const botOffset = topOffset + this.$anchor.innerHeight();

        // Check if the viewport state change to know if we need to move the anchor of the tip.
        // up : the target element is above the current viewport
        // down : the target element is below the current viewport
        // in : the target element is in the current viewport
        let viewPortState = 'in';
        let position = this.info.position;
        if (botOffset - halfHeight < topViewport) {
            viewPortState = 'up';
            position = 'bottom';
        } else if (topOffset + halfHeight > botViewport) {
            viewPortState = 'down';
            position = 'top';
        } else {
            // Adjust the placement of the tip regarding its anchor depending
            // if we came from the bottom or the top.
            if (topOffset < topViewport + this.$el.innerHeight()) {
                position = halfHeight ? this.initialPosition : "bottom";
            } else if (botOffset > botViewport - this.$el.innerHeight()) {
                position = halfHeight ? this.initialPosition : "top";
            }
        }

        // If the direction or the anchor change : The tip position is updated.
        if (forceReposition || this.info.position !== position || this.viewPortState !== viewPortState) {
            this.$el.removeClass('top right bottom left').addClass(position);
            this.viewPortState = viewPortState;
            this.info.position = position;
            let $location;
            if (this.viewPortState === 'in') {
                this.$tooltip_content.html(this.info.content);
                this.$actualAnchor = this.$anchor;
                $location = this.$ideal_location;
            } else {
                this.$tooltip_content.html(this.info.scrollContent);
                this.$actualAnchor = this.$ideal_location;
                $location = this.$furtherIdealLocation;
            }
            // Update o_tooltip_parent class and tip DOM location. Note:
            // important to only remove/add the class when necessary to not
            // notify a DOM mutation which could retrigger this function.
            const $oldLocation = this.$el.parent();
            if (!this.tip_opened) {
                if (!$location.is($oldLocation)) {
                    $oldLocation.removeClass('o_tooltip_parent');
                    const cssPosition = $location.css("position");
                    if (cssPosition === "static" || cssPosition === "relative") {
                        $location.addClass("o_tooltip_parent");
                    }
                    this.$el.appendTo($location);
                }
                this._reposition();
            }
        }
    },
    _get_ideal_location: function ($anchor = this.$anchor) {
        var $location = $anchor;
        if ($location.is("html,body")) {
            return $(document.body);
        }

        var o;
        var p;
        do {
            $location = $location.parent();
            o = $location.css("overflow");
            p = $location.css("position");
        } while (
            $location.hasClass('dropdown-menu') ||
            $location.hasClass('o_notebook_headers') ||
            (
                (o === "visible" || o.includes("hidden")) && // Possible case where the overflow = "hidden auto"
                p !== "fixed" &&
                $location[0].tagName.toUpperCase() !== 'BODY'
            )
        );

        return $location;
    },
    _reposition: function () {
        this.$el.removeClass("o_animated");

        // Reverse left/right position if direction is right to left
        var appendAt = this.info.position;
        var rtlMap = {left: 'right', right: 'left'};
        if (rtlMap[appendAt] && _t.database.parameters.direction === 'rtl') {
            appendAt = rtlMap[appendAt];
        }

        // Get the correct tip's position depending of the tip's state
        let $parent = this.$ideal_location;
        if ($parent.is('html,body') && this.viewPortState !== "in") {
            this.$el.css({position: 'fixed'});
        } else {
            this.$el.css({position: ''});
        }

        if (this.viewPortState === 'in') {
            this.$el.position({
                my: this._get_spaced_inverted_position(appendAt),
                at: appendAt,
                of: this.$anchor,
                collision: "none",
            });
        } else {
            const paddingTop = parseInt($parent.css('padding-top'));
            const paddingLeft = parseInt($parent.css('padding-left'));
            const paddingRight = parseInt($parent.css('padding-right'));
            const topPosition = $parent[0].offsetTop;
            const center = (paddingLeft + paddingRight) + ((($parent[0].clientWidth - (paddingLeft + paddingRight)) / 2) - this.$el[0].offsetWidth / 2);
            let top;
            if (this.viewPortState === 'up') {
                top = topPosition + this.$el.innerHeight() + paddingTop;
            } else {
                top = topPosition + $parent.innerHeight() - this.$el.innerHeight() * 2;
            }
            this.$el.css({top: top, left: center});
        }

        // Reverse overlay if direction is right to left
        var positionRight = _t.database.parameters.direction === 'rtl' ? "right" : "left";
        var positionLeft = _t.database.parameters.direction === 'rtl' ? "left" : "right";

        // get the offset position of this.$el
        // Couldn't use offset() or position() because their values are not the desired ones in all cases
        const offset = {top: this.$el[0].offsetTop, left: this.$el[0].offsetLeft};
        this.$tooltip_overlay.css({
            top: -Math.min((this.info.position === "bottom" ? this.info.space : this.info.overlay.y), offset.top),
            right: -Math.min((this.info.position === positionRight ? this.info.space : this.info.overlay.x), this.$window.width() - (offset.left + this.init_width + this.double_border_width)),
            bottom: -Math.min((this.info.position === "top" ? this.info.space : this.info.overlay.y), this.$window.height() - (offset.top + this.init_height + this.double_border_width)),
            left: -Math.min((this.info.position === positionLeft ? this.info.space : this.info.overlay.x), offset.left),
        });
        this.position = offset;

        this.$el.addClass("o_animated");
    },
    _bind_anchor_events: function () {
        this.consume_event = this.info.consumeEvent || Tip.getConsumeEventType(this.$anchor, this.info.run);
        this.$consumeEventAnchor = this.$anchor;
        if (this.consume_event === "drag") {
            // jQuery-ui draggable triggers 'drag' events on the .ui-draggable element,
            // but the tip is attached to the .ui-draggable-handle element which may
            // be one of its children (or the element itself)
            this.$consumeEventAnchor = this.$anchor.closest('.ui-draggable');
        } else if (this.consume_event === "input" && !this.$anchor.is('textarea, input')) {
            this.$consumeEventAnchor = this.$anchor.closest("[contenteditable='true']");
        } else if (this.consume_event.includes('apply.daterangepicker')) {
            this.$consumeEventAnchor = this.$anchor.parent().children('.o_field_date_range');
        } else if (this.consume_event === "sort") {
            // when an element is dragged inside a sortable container (with classname
            // 'ui-sortable'), jQuery triggers the 'sort' event on the container
            this.$consumeEventAnchor = this.$anchor.closest('.ui-sortable');
        }
        this.$consumeEventAnchor.on(this.consume_event + ".anchor", (function (e) {
            if (e.type !== "mousedown" || e.which === 1) { // only left click
                this.trigger("tip_consumed");
                this._unbind_anchor_events();
            }
        }).bind(this));
        this.$anchor.on('mouseenter.anchor', () => this._to_info_mode());
        this.$anchor.on('mouseleave.anchor', () => this._to_bubble_mode());

        this.$scrolableElement = this.$ideal_location.is('html,body') ? $(window) : this.$ideal_location;
        this.$scrolableElement.on('scroll.Tip', () => this._onAncestorScroll());
    },
    _unbind_anchor_events: function () {
        this.$anchor.off(".anchor");
        this.$consumeEventAnchor.off(".anchor");
        this.$scrolableElement.off('.Tip');
    },
    _get_spaced_inverted_position: function (position) {
        if (position === "right") return "left+" + this.info.space;
        if (position === "left") return "right-" + this.info.space;
        if (position === "bottom") return "top+" + this.info.space;
        return "bottom-" + this.info.space;
    },
    _to_info_mode: function (force) {
        if (this.timerOut !== undefined) {
            clearTimeout(this.timerOut);
            this.timerOut = undefined;
            return;
        }
        if (this.tip_opened) {
            return;
        }

        if (force === true) {
            this._build_info_mode();
        } else {
            this.timerIn = setTimeout(this._build_info_mode.bind(this), 100);
        }
    },
    _build_info_mode: function () {
        clearTimeout(this.timerIn);
        this.timerIn = undefined;

        this.tip_opened = true;

        var offset = this.$el.offset();

        // When this.$el doesn't have any parents, it means that the tip is no
        // longer in the DOM and so, it shouldn't be open. It happens when the
        // tip is opened after being destroyed.
        if (!this.$el.parent().length) {
            return;
        }

        if (this.$el.parent()[0] !== this.$el[0].ownerDocument.body) {
            this.$el.detach();
            this.$el.css(offset);
            this.$el.appendTo(this.$el[0].ownerDocument.body);
        }

        var mbLeft = 0;
        var mbTop = 0;
        var overflow = false;
        var posVertical = (this.info.position === "top" || this.info.position === "bottom");
        if (posVertical) {
            overflow = (offset.left + this.content_width + this.double_border_width + this.info.overlay.x > this.$window.width());
        } else {
            overflow = (offset.top + this.content_height + this.double_border_width + this.info.overlay.y > this.$window.height());
        }
        if (posVertical && overflow || this.info.position === "left" || (_t.database.parameters.direction === 'rtl' && this.info.position == "right")) {
            mbLeft -= (this.content_width - this.init_width);
        }
        if (!posVertical && overflow || this.info.position === "top") {
            mbTop -= (this.content_height - this.init_height);
        }


        const [contentWidth, contentHeight] = this.viewPortState === 'in'
            ? [this.content_width, this.content_height]
            : [this.scrollContentWidth, this.scrollContentHeight];
        this.$el.toggleClass("inverse", overflow);
        this.$el.removeClass("o_animated").addClass("active");
        this.$el.css({
            width: contentWidth,
            height: contentHeight,
            "margin-left": mbLeft,
            "margin-top": mbTop,
        });

        this._transitionEndTimer = setTimeout(() => this._onTransitionEnd(), 400);
    },
    _to_bubble_mode: function (force) {
        if (this.timerIn !== undefined) {
            clearTimeout(this.timerIn);
            this.timerIn = undefined;
            return;
        }
        if (!this.tip_opened) {
            return;
        }

        if (force === true) {
            this._build_bubble_mode();
        } else {
            this.timerOut = setTimeout(this._build_bubble_mode.bind(this), 300);
        }
    },
    _build_bubble_mode: function () {
        clearTimeout(this.timerOut);
        this.timerOut = undefined;

        this.tip_opened = false;

        this.$el.removeClass("active").addClass("o_animated");
        this.$el.css({
            width: this.init_width,
            height: this.init_height,
            margin: 0,
        });

        this._transitionEndTimer = setTimeout(() => this._onTransitionEnd(), 400);
    },

    //--------------------------------------------------------------------------
    // Handlers
    //--------------------------------------------------------------------------

    /**
     * @private
     */
    _onNextStep: function () {
        this.trigger("tip_consumed");
        this._unbind_anchor_events();
    },
    /**
     * @private
     */
    _onAncestorScroll: function () {
        if (this.tip_opened) {
            this._to_bubble_mode(true);
        } else {
            this._updatePosition();
        }
    },
    /**
     * @private
     */
    _onMouseEnter: function () {
        this._to_info_mode();
    },
    /**
     * @private
     */
    _onMouseLeave: function () {
        this._to_bubble_mode();
    },
    /**
     * On touch devices, closes the tip when clicked.
     *
     * @private
     */
    _onTipClicked: function () {
        if (config.device.touch && this.tip_opened) {
            this._to_bubble_mode();
        }
    },
    /**
     * @private
     */
    _onTransitionEnd: function () {
        if (this._transitionEndTimer) {
            clearTimeout(this._transitionEndTimer);
            this._transitionEndTimer = undefined;
            if (!this.tip_opened) {
                this._updatePosition(true);
            }
        }
    },
});

/**
 * @static
 * @param {jQuery} $element
 * @param {string} [run] the run parameter of the tip (only strings are useful)
 */
Tip.getConsumeEventType = function ($element, run) {
    if ($element.hasClass('o_field_many2one') || $element.hasClass('o_field_many2manytags')) {
        return 'autocompleteselect';
    } else if ($element.is("textarea") || $element.filter("input").is(function () {
        var type = $(this).attr("type");
        return !type || !!type.match(/^(email|number|password|search|tel|text|url)$/);
    })) {
        // FieldDateRange triggers a special event when using the widget
        if ($element.hasClass("o_field_date_range")) {
            return "apply.daterangepicker input";
        }
        if (config.device.isMobile &&
            $element.closest('.o_field_widget').is('.o_field_many2one, .o_field_many2many')) {
            return "click";
        }
        return "input";
    } else if ($element.hasClass('ui-draggable-handle')) {
        return "drag";
    } else if (typeof run === 'string' && run.indexOf('drag_and_drop') === 0) {
        // this is a heuristic: the element has to be dragged and dropped but it
        // doesn't have class 'ui-draggable-handle', so we check if it has an
        // ui-sortable parent, and if so, we conclude that its event type is 'sort'
        if ($element.closest('.ui-sortable').length) {
            return 'sort';
        }
    }
    return "click";
};

return Tip;

});
