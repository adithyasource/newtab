const textArea = document.getElementById("textarea");
const fontSidebar = document.getElementById("fontsidebar");
const sideBar = document.getElementById("sidebar");
const hoverChecker = document.getElementById("hoverchecker");
const changeFont = document.getElementById("changefont");
const pageBody = document.getElementById("body");
const darkModeBtn = document.getElementById("darkmodebtn");
const dropDown = document.getElementById("dropdown");
const blurToggle = document.getElementById("blurtogglebtn");
const newStickyNote = document.getElementById("newstickynotebtn");
const toggleStickyNotes = document.getElementById("toggleshowstickiesbtn");
let stickyIdCounter = 0;
let isBlur;
let isDarkMode;
let showStickies;

function getData() {
  isBlur = JSON.parse(localStorage.getItem("isBlur"));
  if (isBlur === null) {
    isBlur = false;
    localStorage.setItem("isBlur", isBlur);
  }

  if (isBlur) {
    document.querySelector("body").classList.add("blur");
  } else {
    document.querySelector("body").classList.remove("blur");
  }

  isDarkMode = JSON.parse(localStorage.getItem("isDarkMode"));
  if (isDarkMode === null) {
    isDarkMode = false;
    localStorage.setItem("isDarkMode", false);
    localStorage.setItem("isDarkMode", isDarkMode);
  }
  if (isDarkMode) {
    darkUI();
  } else {
    lightUI();
  }

  textArea.innerHTML = localStorage.getItem("textareaValue");

  // make sure that running get data refreshes data and doesnt add anything
  document.querySelectorAll(".sticky-note").forEach((el) => el.remove());

  const savedNotes = JSON.parse(localStorage.getItem("stickyNotes")) || [];
  savedNotes.forEach((note) => createStickyNote(note));

  showStickies = JSON.parse(localStorage.getItem("showStickies"));
  if (showStickies === null) {
    showStickies = true;
    localStorage.setItem("showStickies", showStickies);
  }
  if (showStickies) {
    document.querySelectorAll(".sticky-note").forEach((el) => {
      el.style.visibility = "visible";
    });
  } else {
    document.querySelectorAll(".sticky-note").forEach((el) => {
      el.style.visibility = "hidden";
    });
  }

  let fontIndex = localStorage.getItem("fontIndex");
  console.log(fontIndex);
  if (fontIndex === null) {
    fontIndex = 0;
  }
  const fontLocalStorage = dropDown.options[fontIndex];
  dropDown.selectedIndex = fontIndex;
  document.body.style.fontFamily = fontLocalStorage.value;
  localStorage.setItem("fontIndex", fontIndex);

  // checks device color scheme and changes favicon color accordingly
  var favIcon = document.getElementById("favicon");
  var browserIsDark = window.matchMedia("(prefers-color-scheme: dark)");
  if (browserIsDark.matches) {
    favIcon.href = "/images/128-light.png";
  } else {
    favIcon.href = "/images/128.png";
  }

  textArea.addEventListener("input", () => {
    localStorage.setItem("textareaValue", textArea.innerHTML);
  });

  document.querySelectorAll("[contenteditable]").forEach((el) => {
    attachContentEditableEventListeners(el);
  });

  document.querySelectorAll(".todo-check").forEach((el) => {
    attachTodoEventListeners(el);

    if (el.innerHTML === "[x]") {
      el.parentElement.style.opacity = "50%";
    }
  });
}

function attachEventListeners() {
  darkModeBtn.addEventListener("click", toggleDarkMode);

  // checks for any changes in the font selector and saves it to localStorage also remembers the index of that option
  dropDown.addEventListener("change", () => {
    const selectedOption = dropDown.options[dropDown.selectedIndex].value;
    localStorage.setItem("fontIndex", dropDown.selectedIndex);
    pageBody.style.fontFamily = selectedOption;

    sideBar.style.animationName = "out";
    fontSidebar.style.visibility = "hidden";
    sideBar.style.visibility = "hidden";

    hoverChecker.style.width = "1.3vw";
    hoverChecker.style.height = "13em";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      console.log("user came back");
      getData();
    } else {
      console.log("user left the page");
    }
  });

  // checks if changeFont button is clicked
  changeFont.addEventListener("click", () => {
    fontSidebar.style.visibility = "visible";
  });

  blurToggle.addEventListener("click", () => {
    toggleBlur();
  });

  newStickyNote.addEventListener("click", () => {
    createStickyNote();
  });

  toggleStickyNotes.addEventListener("click", (e) => {
    toggleShowStickies(e);
  });

  // checks if a certain part of the screen is being hovered on for a period of time and then makes the sidebar visible
  hoverChecker.addEventListener("mouseenter", () => {
    sideBar.style.visibility = "visible";
    sideBar.style.animationName = "in";

    hoverChecker.style.width = "40vw";
    hoverChecker.style.height = "13em";
  });

  hoverChecker.addEventListener("mouseleave", () => {
    sideBar.style.animationName = "out";
    fontSidebar.style.visibility = "hidden";
    sideBar.style.visibility = "hidden";

    hoverChecker.style.width = "1.3vw";
    hoverChecker.style.height = "13em";
  });
}

function attachContentEditableEventListeners(el) {
  el.addEventListener("paste", async (e) => {
    e.preventDefault();
    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.type.indexOf("image") !== -1) {
        const blob = item.getAsFile();
        const reader = new FileReader();
        reader.onload = (event) => {
          document.execCommand("insertImage", false, event.target.result);
        };
        reader.readAsDataURL(blob);
      } else if (item.type === "text/plain") {
        item.getAsString((text) => {
          const html = text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\t/g, "&emsp;")
            .replace(/ {2}/g, "&nbsp;&nbsp;") // handles double spaces
            .replace(/\n/g, "<br>");
          document.execCommand("insertHTML", false, html);
        });
      }
    }
  });

  el.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      document.execCommand("insertText", false, "\t"); // 4 spaces
    }

    if (e.ctrlKey && e.key === " ") {
      console.log("add todo");

      const todoId = generateRandomString();

      const span = document.createElement("span");
      span.className = "todo";
      span.style.display = "block";

      const button = document.createElement("button");
      button.className = "todo-check";
      button.contentEditable = "false";
      button.dataset.todoid = todoId;
      button.textContent = "[ ]";

      const textNode = document.createTextNode("\u200B");

      span.appendChild(button);
      span.appendChild(textNode);

      const selection = window.getSelection();
      if (!selection.rangeCount) return;

      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(span);

      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);

      setTimeout(() => {
        attachTodoEventListeners(document.querySelector(`[data-todoid="${todoId}"]`));
      }, 10);
    }
  });
}

function createStickyNote(noteData = null) {
  stickyIdCounter++;

  const id = noteData?.id || `sticky-${stickyIdCounter}`;
  const x = noteData?.left || 100 + stickyIdCounter * 20;
  const y = noteData?.top || 100 + stickyIdCounter * 20;
  const content = noteData?.content || "";

  // Set default width and height if not defined
  const width = noteData?.width || 400;
  const height = noteData?.height || 300;

  const sticky = document.createElement("div");
  sticky.classList.add("sticky-note");
  sticky.setAttribute("id", id);
  sticky.style.left = `${x}px`;
  sticky.style.top = `${y}px`;
  sticky.style.width = `${width}px`;
  sticky.style.height = `${height}px`;

  sticky.innerHTML = `
    <div class="sticky-header"></div>
    <div class="sticky-content" contenteditable="true">${content}</div>
    <button class="sticky-close">x</button>
  `;

  document.body.appendChild(sticky);

  const resizeObserver = new ResizeObserver(() => {
    saveStickyNotes();
  });
  resizeObserver.observe(sticky);

  // applyStickyNoteTheme(sticky);
  makeStickyDraggable(sticky);

  const stickyContent = sticky.querySelector(".sticky-content");

  sticky.querySelector(".sticky-close").addEventListener("click", () => {
    sticky.remove();
    deleteStickyNote(id);
  });

  stickyContent.addEventListener("input", () => {
    saveStickyNotes();
  });

  saveStickyNotes();

  return sticky;
}

function attachTodoEventListeners(el) {
  el.addEventListener("click", () => {
    if (el.innerHTML === "[ ]") {
      el.innerHTML = "[x]";
      el.parentElement.style.opacity = "50%";
    } else {
      el.innerHTML = "[ ]";
      el.parentElement.style.opacity = "100%";
    }

    saveStickyNotes();
  });
}

function makeStickyDraggable(sticky) {
  const header = sticky.querySelector(".sticky-header");
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;
  let debounceTimeout;

  function startDragging(e) {
    isDragging = true;
    offsetX = e.clientX - sticky.offsetLeft;
    offsetY = e.clientY - sticky.offsetTop;
    sticky.style.zIndex = ++stickyIdCounter + 10000;
  }

  function drag(e) {
    if (isDragging) {
      sticky.style.left = `${e.clientX - offsetX}px`;
      sticky.style.top = `${e.clientY - offsetY}px`;

      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        saveStickyNotes();
      }, 500);
    }
  }

  sticky.addEventListener("mousedown", (e) => {
    sticky.style.zIndex = ++stickyIdCounter + 10000;
    console.log(e);

    if (e.ctrlKey || e.metaKey) {
      startDragging(e);
    }
  });

  header.addEventListener("mousedown", (e) => {
    startDragging(e);
  });

  document.addEventListener("mousemove", (e) => {
    drag(e);
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });
}

function saveStickyNotes() {
  const stickies = document.querySelectorAll(".sticky-note");
  const data = [];

  stickies.forEach((sticky) => {
    const id = sticky.id;
    const left = Number.parseInt(sticky.style.left, 10);
    const top = Number.parseInt(sticky.style.top, 10);
    const content = sticky.querySelector(".sticky-content").innerHTML; // Changed from .value to .innerHTML

    // Get the actual CSS width and height instead of offsetWidth/offsetHeight
    const width = Number.parseInt(sticky.style.width, 10) || 200;
    const height = Number.parseInt(sticky.style.height, 10) || 150;

    data.push({ id, left, top, content, width, height });
  });

  localStorage.setItem("stickyNotes", JSON.stringify(data));
}

function deleteStickyNote(id) {
  const stickies = JSON.parse(localStorage.getItem("stickyNotes")) || [];
  const filtered = stickies.filter((note) => note.id !== id);
  localStorage.setItem("stickyNotes", JSON.stringify(filtered));
}

function darkUI() {
  document.querySelector(":root").style.setProperty("--scheme", "dark");
}

function lightUI() {
  document.querySelector(":root").style.setProperty("--scheme", "light");
}

function generateRandomString() {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  let result = "";
  const charactersLength = characters.length;
  for (let i = 0; i < 5; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }

  return result;
}

function toggleDarkMode() {
  isDarkMode = !isDarkMode;
  localStorage.setItem("isDarkMode", isDarkMode);

  if (isDarkMode) {
    darkUI();
  } else {
    lightUI();
  }
}

function toggleBlur() {
  if (isBlur) {
    document.querySelector("body").classList.remove("blur");
  } else {
    document.querySelector("body").classList.add("blur");
  }
  isBlur = !isBlur;
  localStorage.setItem("isBlur", isBlur);
}

function main() {
  getData();
  attachEventListeners();

  window.addEventListener("DOMContentLoaded", () => {
    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey) {
        if (e.shiftKey && e.key === "Q") {
          toggleDarkMode();
        }

        if (e.key === "q") {
          toggleBlur();
        }

        if (e.key === "e") {
          e.preventDefault();
          document.querySelectorAll(".sticky-note").forEach((el) => {
            el.style.visibility = "visible";
          });
          showStickies = true;
          localStorage.setItem("showStickies", showStickies);
          const sticky = createStickyNote();
          attachContentEditableEventListeners(sticky);
        }

        if (e.shiftKey && e.key === "E") {
          toggleShowStickies(e);
        }
      }
    });
  });
}

function toggleShowStickies(e) {
  e.preventDefault();
  showStickies = !showStickies;
  if (showStickies) {
    document.querySelectorAll(".sticky-note").forEach((el) => {
      el.style.visibility = "visible";
    });
  } else {
    document.querySelectorAll(".sticky-note").forEach((el) => {
      el.style.visibility = "hidden";
    });
  }

  localStorage.setItem("showStickies", showStickies);
}

main();
